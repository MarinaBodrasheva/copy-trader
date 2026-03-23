import { placeMarketOrder } from '../api/tradovate.js';
import { config } from '../config/index.js';
import { logFailure } from './FailureLogger.js';
import { alertCopyFailure, sendAlert } from './Alerter.js';

const CLOSE_VERIFY_DELAY_MS = 3000; // wait 3s after placing close before checking
const CLOSE_MAX_RETRIES     = 2;    // retry the close this many times before giving up

export class CopyEngine {
  constructor(positionTracker) {
    this.slaveAccountIds = config.slaveAccountIds;
    this.positionTracker = positionTracker;
    this.processedFills  = new Set();
  }

  // ── Entry point for ALL fills from the WebSocket ───────────────────────────

  async onFill(fill) {
    if (fill.accountId === config.masterAccountId) {
      await this._handleMasterFill(fill);
    } else if (config.slaveAccountIds.includes(fill.accountId)) {
      this._handleSlaveFill(fill);
    }
  }

  // ── Slave fill: update position from the actual confirmed fill event ────────

  _handleSlaveFill(fill) {
    const { accountId, contractId, action, qty } = fill;
    if (!contractId || !action || !qty) return;

    this.positionTracker.applyFill(accountId, contractId, action, qty);
    console.log(`[CopyEngine] Slave ${accountId} fill confirmed — ${action} ${qty}x ${contractId}`);
  }

  // ── Master fill: copy to all slaves ────────────────────────────────────────

  async _handleMasterFill(fill) {
    if (this.processedFills.has(fill.orderId)) return;
    this.processedFills.add(fill.orderId);

    const { contractId, action, qty } = fill;

    if (!contractId || !action || !qty) {
      console.warn('[CopyEngine] Incomplete fill data, skipping:', fill);
      return;
    }

    console.log(`[CopyEngine] Master fill — ${action} ${qty}x contractId:${contractId}`);

    const isClose = this.positionTracker.isClosingFill(config.masterAccountId, contractId, action);
    this.positionTracker.applyFill(config.masterAccountId, contractId, action, qty);

    await Promise.all(
      this.slaveAccountIds.map((accountId) =>
        this._copyToSlave({ accountId, contractId, action, qty, orderId: fill.orderId, isClose })
      )
    );

    if (isClose) {
      await this._verifySlavesClosed({ contractId, action, qty, orderId: fill.orderId });
    }

    if (this.processedFills.size > 1000) {
      const first = this.processedFills.values().next().value;
      this.processedFills.delete(first);
    }
  }

  // ── Copy a single fill to one slave ────────────────────────────────────────

  async _copyToSlave({ accountId, contractId, action, qty, orderId, isClose }) {
    // Safety guard: don't send a close to a flat slave — it would open a reverse position
    if (isClose) {
      const slaveQty = this.positionTracker.getNetQty(accountId, contractId);
      if (slaveQty === 0) {
        const error =
          `Slave has no open ${contractId} position — ` +
          `skipping close to prevent unintended reverse trade`;
        console.warn(`[CopyEngine] ⚠️  Slave ${accountId}: ${error}`);
        logFailure({ slaveAccountId: accountId, contractId, action, qty, orderId, error });
        await alertCopyFailure({ slaveAccountId: accountId, contractId, action, qty, error });
        return;
      }
    }

    try {
      const res = await placeMarketOrder({ accountId, symbol: contractId, action, orderQty: qty });
      // Position state is NOT updated here optimistically.
      // It will be updated when the actual slave fill event arrives via onFill → _handleSlaveFill.
      console.log(`[CopyEngine] ✓ Slave ${accountId} order placed:`, res.orderId || res);
    } catch (err) {
      const error = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err?.message ?? 'Unknown error';
      console.error(`[CopyEngine] ✗ Failed to copy to slave ${accountId}:`, error);
      logFailure({ slaveAccountId: accountId, contractId, action, qty, orderId, error });
      await alertCopyFailure({ slaveAccountId: accountId, contractId, action, qty, error });
    }
  }

  // ── Post-close verification ─────────────────────────────────────────────────

  /**
   * After master closes, wait briefly for slave fill events to arrive, then
   * verify each slave is flat via the API. Retries if not.
   */
  async _verifySlavesClosed({ contractId, action, qty, orderId }) {
    await _sleep(CLOSE_VERIFY_DELAY_MS);

    for (const accountId of this.slaveAccountIds) {
      await this._ensureSlaveClosed({ accountId, contractId, action, qty, orderId });
    }
  }

  async _ensureSlaveClosed({ accountId, contractId, action, qty, orderId, attempt = 1 }) {
    // Always verify against the real API — catches missed fill events
    await this.positionTracker.refreshAccount(accountId);
    const liveQty = this.positionTracker.getNetQty(accountId, contractId);

    if (liveQty === 0) {
      console.log(`[CopyEngine] ✓ Slave ${accountId} confirmed flat on ${contractId}`);
      return;
    }

    console.warn(
      `[CopyEngine] ⚠️  Slave ${accountId} still holds ${liveQty} ${contractId} after master closed (attempt ${attempt})`
    );

    if (attempt > CLOSE_MAX_RETRIES) {
      const msg =
        `<b>🚨 CRITICAL — Slave not closed after ${CLOSE_MAX_RETRIES} retries</b>\n` +
        `Slave: <code>${accountId}</code>\n` +
        `Contract: <code>${contractId}</code>\n` +
        `Open qty: <code>${liveQty}</code>\n` +
        `Manual close required immediately.`;
      console.error(`[CopyEngine] CRITICAL: ${msg}`);
      logFailure({
        slaveAccountId: accountId,
        contractId,
        action,
        qty: liveQty,
        orderId,
        error: `Not closed after ${CLOSE_MAX_RETRIES} retries — manual intervention required`,
      });
      await sendAlert(msg);
      return;
    }

    console.log(`[CopyEngine] Retrying close for slave ${accountId} (attempt ${attempt})...`);
    try {
      const res = await placeMarketOrder({
        accountId,
        symbol: contractId,
        action,
        orderQty: Math.abs(liveQty),
      });
      console.log(`[CopyEngine] ✓ Retry close placed for slave ${accountId}:`, res.orderId || res);
    } catch (err) {
      const error = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err?.message ?? 'Unknown error';
      console.error(`[CopyEngine] ✗ Retry close failed for slave ${accountId}:`, error);
    }

    await _sleep(CLOSE_VERIFY_DELAY_MS);
    await this._ensureSlaveClosed({ accountId, contractId, action, qty, orderId, attempt: attempt + 1 });
  }
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
