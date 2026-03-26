import { placeMarketOrder, getPositions } from '../api/tradovate.js';
import { config } from '../config/index.js';
import { logFailure } from './FailureLogger.js';
import { alertCopyFailure, sendAlert } from './Alerter.js';
import { DailyLossGuard } from './DailyLossGuard.js';
import type { AccountId, Action, ContractId, Fill, IPositionTracker } from '../types.js';

const CLOSE_VERIFY_DELAY_MS = 3000;
const CLOSE_MAX_RETRIES     = 2;

interface CopyContext {
  accountId:  AccountId;
  contractId: ContractId;
  action:     Action;
  qty:        number;
  orderId:    number;
  isClose:    boolean;
}

interface VerifyContext {
  contractId: ContractId;
  action:     Action;
  qty:        number;
  orderId:    number;
  attempt?:   number;
}

export class CopyEngine {
  private readonly processedFills  = new Set<number>();
  private readonly disabledSlaves  = new Set<AccountId>();
  private masterId: AccountId;

  constructor(
    private readonly positionTracker: IPositionTracker,
    private readonly dailyLossGuard?: DailyLossGuard,
  ) {
    this.masterId = config.masterAccountId;
  }

  // ── Runtime master / slave control ────────────────────────────────────────

  getMasterId(): AccountId { return this.masterId; }

  setMaster(accountId: AccountId): void {
    this.masterId = accountId;
    console.log(`[CopyEngine] Master changed to ${accountId}`);
  }

  /** All configured accounts except the current master. */
  getSlaveIds(): AccountId[] {
    const all = [config.masterAccountId, ...config.slaveAccountIds];
    return all.filter(id => id !== this.masterId);
  }

  async setSlaveEnabled(accountId: AccountId, enabled: boolean): Promise<void> {
    if (enabled) {
      this.disabledSlaves.delete(accountId);
      console.log(`[CopyEngine] Slave ${accountId} enabled`);
      return;
    }

    // Disable first — immediately stops any new copies from being sent
    this.disabledSlaves.add(accountId);
    console.log(`[CopyEngine] Slave ${accountId} disabled — flattening open positions`);

    // Then close whatever is still open
    await this._flattenSlave(accountId);
  }

  isSlaveEnabled(accountId: AccountId): boolean {
    return !this.disabledSlaves.has(accountId);
  }

  private async _flattenSlave(accountId: AccountId): Promise<void> {
    let positions;
    try {
      positions = await getPositions(accountId);
    } catch (err) {
      console.error(`[CopyEngine] Failed to fetch positions for slave ${accountId} during flatten:`,
        err instanceof Error ? err.message : String(err));
      return;
    }

    const open = positions.filter(p => p.netPos !== 0);
    if (open.length === 0) {
      console.log(`[CopyEngine] Slave ${accountId} has no open positions`);
      return;
    }

    await Promise.all(open.map(p =>
      placeMarketOrder({
        accountId,
        symbol:   p.contractId,
        action:   p.netPos > 0 ? 'Sell' : 'Buy',
        orderQty: Math.abs(p.netPos),
      }).catch(err => {
        console.error(`[CopyEngine] Failed to close ${p.contractId} on slave ${accountId}:`,
          err instanceof Error ? err.message : String(err));
      }),
    ));

    console.log(`[CopyEngine] Slave ${accountId} flattened — ${open.length} position(s) closed`);
  }

  // ── Entry point for ALL fills from the WebSocket ───────────────────────────

  async onFill(fill: Fill): Promise<void> {
    if (fill.accountId === this.masterId) {
      await this._handleMasterFill(fill);
    } else if (this.getSlaveIds().includes(fill.accountId)) {
      this._handleSlaveFill(fill);
    }
  }

  // ── Slave fill: update position from the actual confirmed fill event ────────

  private _handleSlaveFill(fill: Fill): void {
    const { accountId, contractId, action, qty } = fill;
    if (!contractId || !action || !qty) return;

    this.positionTracker.applyFill(accountId, contractId, action, qty);
    console.log(`[CopyEngine] Slave ${accountId} fill confirmed — ${action} ${qty}x ${contractId}`);
  }

  // ── Master fill: copy to all slaves ────────────────────────────────────────

  private async _handleMasterFill(fill: Fill): Promise<void> {
    if (this.processedFills.has(fill.orderId)) return;
    this.processedFills.add(fill.orderId);

    const { contractId, action, qty } = fill;

    if (!contractId || !action || !qty) {
      console.warn('[CopyEngine] Incomplete fill data, skipping:', fill);
      return;
    }

    console.log(`[CopyEngine] Master fill — ${action} ${qty}x contractId:${contractId}`);

    const isClose = this.positionTracker.isClosingFill(this.masterId, contractId, action);
    this.positionTracker.applyFill(this.masterId, contractId, action, qty);

    await Promise.all(
      this.getSlaveIds().map(accountId =>
        this._copyToSlave({ accountId, contractId, action, qty, orderId: fill.orderId, isClose }),
      ),
    );

    if (isClose) {
      await this._verifySlavesClosed({ contractId, action, qty, orderId: fill.orderId });
    }

    if (this.processedFills.size > 1000) {
      const first = this.processedFills.values().next().value!;
      this.processedFills.delete(first);
    }
  }

  // ── Copy a single fill to one slave ────────────────────────────────────────

  private async _copyToSlave(ctx: CopyContext): Promise<void> {
    const { accountId, contractId, action, qty, orderId, isClose } = ctx;

    // Slave disabled via dashboard toggle
    if (!this.isSlaveEnabled(accountId)) {
      console.log(`[CopyEngine] Slave ${accountId} is disabled — skipping copy`);
      return;
    }

    // Daily loss guard: skip if this slave has hit its daily loss limit
    if (this.dailyLossGuard?.isLocked(accountId)) {
      console.warn(`[CopyEngine] ⛔ Slave ${accountId} is locked by daily loss guard — skipping copy`);
      return;
    }

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
      // Position state is updated only when the actual slave fill event arrives via onFill
      console.log(`[CopyEngine] ✓ Slave ${accountId} order placed:`, res.orderId ?? res);
    } catch (err) {
      const error = isAxiosError(err)
        ? JSON.stringify(err.response?.data)
        : err instanceof Error ? err.message : 'Unknown error';
      console.error(`[CopyEngine] ✗ Failed to copy to slave ${accountId}:`, error);
      logFailure({ slaveAccountId: accountId, contractId, action, qty, orderId, error });
      await alertCopyFailure({ slaveAccountId: accountId, contractId, action, qty, error });
    }
  }

  // ── Post-close verification ─────────────────────────────────────────────────

  private async _verifySlavesClosed(ctx: Omit<VerifyContext, 'attempt'>): Promise<void> {
    await sleep(CLOSE_VERIFY_DELAY_MS);
    for (const accountId of this.getSlaveIds()) {
      await this._ensureSlaveClosed({ ...ctx, accountId, attempt: 1 });
    }
  }

  private async _ensureSlaveClosed(
    ctx: VerifyContext & { accountId: AccountId },
  ): Promise<void> {
    const { accountId, contractId, action, qty, orderId, attempt = 1 } = ctx;

    // Always verify against the real API — catches missed fill events
    await this.positionTracker.refreshAccount(accountId);
    const liveQty = this.positionTracker.getNetQty(accountId, contractId);

    if (liveQty === 0) {
      console.log(`[CopyEngine] ✓ Slave ${accountId} confirmed flat on ${contractId}`);
      return;
    }

    console.warn(
      `[CopyEngine] ⚠️  Slave ${accountId} still holds ${liveQty} ${contractId} after master closed (attempt ${attempt})`,
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
        symbol:   contractId,
        action,
        orderQty: Math.abs(liveQty),
      });
      console.log(`[CopyEngine] ✓ Retry close placed for slave ${accountId}:`, res.orderId ?? res);
    } catch (err) {
      const error = isAxiosError(err)
        ? JSON.stringify(err.response?.data)
        : err instanceof Error ? err.message : 'Unknown error';
      console.error(`[CopyEngine] ✗ Retry close failed for slave ${accountId}:`, error);
    }

    await sleep(CLOSE_VERIFY_DELAY_MS);
    await this._ensureSlaveClosed({ accountId, contractId, action, qty, orderId, attempt: attempt + 1 });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface AxiosErrorShape {
  response?: { data?: unknown };
}

function isAxiosError(err: unknown): err is AxiosErrorShape {
  return typeof err === 'object' && err !== null && 'response' in err;
}
