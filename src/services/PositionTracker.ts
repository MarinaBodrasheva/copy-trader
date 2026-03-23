import { getPositions } from '../api/tradovate.js';
import { sendAlert } from './Alerter.js';
import { config } from '../config/index.js';
import type { AccountId, Action, ContractId, IPositionTracker } from '../types.js';

const RECONCILE_INTERVAL = 5 * 60 * 1000; // every 5 minutes

export class PositionTracker implements IPositionTracker {
  // positions.get(accountId)?.get(contractId) → net qty (positive = long, negative = short)
  private readonly positions = new Map<AccountId, Map<ContractId, number>>();

  async initialize(): Promise<void> {
    const allAccounts: AccountId[] = [config.masterAccountId, ...config.slaveAccountIds];
    for (const accountId of allAccounts) {
      await this._loadFromApi(accountId);
    }
    setInterval(() => this.reconcile(), RECONCILE_INTERVAL);
    console.log('[PositionTracker] Initialized — positions loaded for all accounts');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getNetQty(accountId: AccountId, contractId: ContractId): number {
    return this.positions.get(accountId)?.get(contractId) ?? 0;
  }

  /**
   * Returns true if this fill would reduce or close an existing position.
   * Must be called BEFORE applyFill so the pre-fill state is checked.
   */
  isClosingFill(accountId: AccountId, contractId: ContractId, action: Action): boolean {
    const qty = this.getNetQty(accountId, contractId);
    if (qty > 0 && action === 'Sell') return true; // closing / reducing long
    if (qty < 0 && action === 'Buy')  return true; // closing / reducing short
    return false;
  }

  applyFill(accountId: AccountId, contractId: ContractId, action: Action, qty: number): void {
    if (!this.positions.has(accountId)) {
      this.positions.set(accountId, new Map());
    }
    const accountMap = this.positions.get(accountId)!;
    const delta = action === 'Buy' ? qty : -qty;
    const next  = (accountMap.get(contractId) ?? 0) + delta;

    if (next === 0) {
      accountMap.delete(contractId);
    } else {
      accountMap.set(contractId, next);
    }
  }

  /** Force-refreshes one account's positions from the API (used by close verification). */
  async refreshAccount(accountId: AccountId): Promise<void> {
    await this._loadFromApi(accountId);
  }

  // ── Periodic reconciliation ────────────────────────────────────────────────

  async reconcile(): Promise<void> {
    console.log('[PositionTracker] Reconciling positions...');
    try {
      const masterMap = await this._loadFromApi(config.masterAccountId);

      for (const slaveId of config.slaveAccountIds) {
        const slaveMap = await this._loadFromApi(slaveId);

        const allContracts = new Set<ContractId>([...masterMap.keys(), ...slaveMap.keys()]);

        for (const contractId of allContracts) {
          const masterQty = masterMap.get(contractId) ?? 0;
          const slaveQty  = slaveMap.get(contractId)  ?? 0;

          if (masterQty !== slaveQty) {
            console.warn(
              `[PositionTracker] Mismatch — slave ${slaveId} | ${contractId} | master: ${masterQty} slave: ${slaveQty}`,
            );
            await sendAlert(
              `<b>⚠️ Position Mismatch Detected</b>\n` +
              `Slave: <code>${slaveId}</code>\n` +
              `Contract: <code>${contractId}</code>\n` +
              `Master net: <code>${masterQty}</code> | Slave net: <code>${slaveQty}</code>\n` +
              `Manual intervention may be required.`,
            );
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PositionTracker] Reconciliation error:', msg);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async _loadFromApi(accountId: AccountId): Promise<Map<ContractId, number>> {
    try {
      const raw = await getPositions(accountId);
      const map = new Map<ContractId, number>();
      for (const pos of raw) {
        if (pos.netPos !== 0) map.set(pos.contractId, pos.netPos);
      }
      this.positions.set(accountId, map);
      return map;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PositionTracker] Failed to load positions for ${accountId}:`, msg);
      return this.positions.get(accountId) ?? new Map();
    }
  }
}
