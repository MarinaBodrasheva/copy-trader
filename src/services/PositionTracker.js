import { getPositions } from '../api/tradovate.js';
import { sendAlert } from './Alerter.js';
import { config } from '../config/index.js';

const RECONCILE_INTERVAL = 5 * 60 * 1000; // every 5 minutes

export class PositionTracker {
  constructor() {
    // positions[accountId][contractId] = netQty  (positive = long, negative = short)
    this.positions = {};
  }

  async initialize() {
    const allAccounts = [config.masterAccountId, ...config.slaveAccountIds];
    for (const accountId of allAccounts) {
      await this._loadFromApi(accountId);
    }
    setInterval(() => this.reconcile(), RECONCILE_INTERVAL);
    console.log('[PositionTracker] Initialized — positions loaded for all accounts');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns net quantity for an account/contract. 0 means flat. */
  getNetQty(accountId, contractId) {
    return this.positions[accountId]?.[contractId] ?? 0;
  }

  /**
   * Returns true if this fill would reduce or close an existing position.
   * Must be called BEFORE applyFill so the pre-fill position is checked.
   */
  isClosingFill(accountId, contractId, action) {
    const qty = this.getNetQty(accountId, contractId);
    if (qty > 0 && action === 'Sell') return true; // closing / reducing long
    if (qty < 0 && action === 'Buy')  return true; // closing / reducing short
    return false;
  }

  /** Updates local position state after a confirmed fill. */
  applyFill(accountId, contractId, action, qty) {
    if (!this.positions[accountId]) this.positions[accountId] = {};
    const delta = action === 'Buy' ? qty : -qty;
    const next = (this.positions[accountId][contractId] ?? 0) + delta;
    if (next === 0) {
      delete this.positions[accountId][contractId];
    } else {
      this.positions[accountId][contractId] = next;
    }
  }

  // ── Periodic reconciliation ────────────────────────────────────────────────

  /**
   * Fetches live positions for all accounts, refreshes local state,
   * and alerts on any master/slave mismatch.
   */
  async reconcile() {
    console.log('[PositionTracker] Reconciling positions...');
    try {
      const masterPositions = await this._loadFromApi(config.masterAccountId);

      for (const slaveId of config.slaveAccountIds) {
        const slavePositions = await this._loadFromApi(slaveId);

        const allContracts = new Set([
          ...Object.keys(masterPositions),
          ...Object.keys(slavePositions),
        ]);

        for (const contractId of allContracts) {
          const masterQty = masterPositions[contractId] ?? 0;
          const slaveQty  = slavePositions[contractId]  ?? 0;

          if (masterQty !== slaveQty) {
            console.warn(
              `[PositionTracker] Mismatch — slave ${slaveId} | ${contractId} | master: ${masterQty} slave: ${slaveQty}`
            );
            await sendAlert(
              `<b>⚠️ Position Mismatch Detected</b>\n` +
              `Slave: <code>${slaveId}</code>\n` +
              `Contract: <code>${contractId}</code>\n` +
              `Master net: <code>${masterQty}</code> | Slave net: <code>${slaveQty}</code>\n` +
              `Manual intervention may be required.`
            );
          }
        }
      }
    } catch (err) {
      console.error('[PositionTracker] Reconciliation error:', err.message);
    }
  }

  /** Force-refreshes one account's positions from the API (used by close verification). */
  async refreshAccount(accountId) {
    await this._loadFromApi(accountId);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Fetches positions from API, updates local state, and returns contractId→netQty map. */
  async _loadFromApi(accountId) {
    try {
      const raw = await getPositions(accountId);
      const map = {};
      for (const pos of raw) {
        if (pos.netPos !== 0) map[pos.contractId] = pos.netPos;
      }
      this.positions[accountId] = map;
      return map;
    } catch (err) {
      console.error(`[PositionTracker] Failed to load positions for ${accountId}:`, err.message);
      return this.positions[accountId] ?? {};
    }
  }
}
