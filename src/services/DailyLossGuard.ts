import { getCashBalance } from '../api/tradovate.js';
import { logFailure } from './FailureLogger.js';
import { sendAlert } from './Alerter.js';
import type { AccountId, CashBalanceUpdate } from '../types.js';

// REST poll is now only a safety net — WS is the primary update path
const CHECK_INTERVAL_MS = 60_000;

interface PnlSnapshot {
  realized: number;
  open:     number;
}

export class DailyLossGuard {
  private readonly lockedAccounts  = new Set<AccountId>();
  private readonly alertedAccounts = new Set<AccountId>();
  private readonly pnlByAccount    = new Map<AccountId, PnlSnapshot>();
  private checkInterval?: ReturnType<typeof setInterval>;
  private currentTradeDate = '';

  constructor(
    private readonly slaveAccountIds:     AccountId[],
    private readonly maxDailyLossUsd:     number, // realized only  (0 = disabled)
    private readonly maxTotalDailyLossUsd: number, // realized + open (0 = disabled)
  ) {}

  /** Fetch initial P&L via REST and start background safety-net polling. */
  async initialize(): Promise<void> {
    this.currentTradeDate = todayUtc();
    await this._checkAll();
    this.checkInterval = setInterval(() => void this._tick(), CHECK_INTERVAL_MS);
  }

  /** Fast synchronous check — called before every copy attempt. */
  isLocked(accountId: AccountId): boolean {
    return this.lockedAccounts.has(accountId);
  }

  /**
   * Called by TradovateSocket whenever a cashBalance WebSocket event arrives.
   * Updates in-memory P&L and immediately evaluates limits — no REST call needed.
   */
  applyUpdate(update: CashBalanceUpdate): void {
    if (!this.slaveAccountIds.includes(update.accountId)) return;

    const snap = this.pnlByAccount.get(update.accountId) ?? { realized: 0, open: 0 };
    if (update.realizedPnl !== undefined) snap.realized = update.realizedPnl;
    if (update.openPnL     !== undefined) snap.open     = update.openPnL;
    this.pnlByAccount.set(update.accountId, snap);

    void this._evaluate(update.accountId, snap);
  }

  /** Stop the background interval (call on shutdown). */
  destroy(): void {
    if (this.checkInterval !== undefined) clearInterval(this.checkInterval);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    const today = todayUtc();
    if (today !== this.currentTradeDate) {
      this.currentTradeDate = today;
      this.lockedAccounts.clear();
      this.alertedAccounts.clear();
      this.pnlByAccount.clear();
      console.log('[DailyLossGuard] New trading day — all slave accounts unlocked');
    }
    await this._checkAll();
  }

  private async _checkAll(): Promise<void> {
    await Promise.all(this.slaveAccountIds.map(id => this._checkAccount(id)));
  }

  /** REST safety-net poll — updates pnlByAccount then evaluates limits. */
  private async _checkAccount(accountId: AccountId): Promise<void> {
    if (this.lockedAccounts.has(accountId)) return;

    let balance;
    try {
      balance = await getCashBalance(accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[DailyLossGuard] Failed to fetch balance for slave ${accountId}: ${msg}`);
      return;
    }

    if (!balance) {
      console.warn(`[DailyLossGuard] No cash balance found for slave ${accountId}`);
      return;
    }

    const snap = this.pnlByAccount.get(accountId) ?? { realized: 0, open: 0 };
    snap.realized = balance.realizedPnl;
    if (balance.openPnL !== undefined) snap.open = balance.openPnL;
    this.pnlByAccount.set(accountId, snap);

    await this._evaluate(accountId, snap);
  }

  /** Check both limits and lock the account if either is breached. */
  private async _evaluate(accountId: AccountId, snap: PnlSnapshot): Promise<void> {
    if (this.lockedAccounts.has(accountId)) return;

    const { realized, open } = snap;
    const total = realized + open;

    const realizedBreached = this.maxDailyLossUsd      > 0 && realized < -this.maxDailyLossUsd;
    const totalBreached    = this.maxTotalDailyLossUsd > 0 && total    < -this.maxTotalDailyLossUsd;

    if (!realizedBreached && !totalBreached) return;

    this.lockedAccounts.add(accountId);

    const reason = totalBreached
      ? `total loss $${Math.abs(total).toFixed(2)} (realized $${Math.abs(realized).toFixed(2)} + open $${Math.abs(open).toFixed(2)}) exceeds limit $${this.maxTotalDailyLossUsd}`
      : `realized loss $${Math.abs(realized).toFixed(2)} exceeds limit $${this.maxDailyLossUsd}`;

    console.warn(`[DailyLossGuard] ⛔ Slave ${accountId} locked — ${reason}`);

    if (this.alertedAccounts.has(accountId)) return;
    this.alertedAccounts.add(accountId);

    const limitLine = totalBreached
      ? `Total P&amp;L (realized + open): <code>-$${Math.abs(total).toFixed(2)}</code>  |  Limit: <code>$${this.maxTotalDailyLossUsd}</code>`
      : `Realized P&amp;L today: <code>-$${Math.abs(realized).toFixed(2)}</code>  |  Limit: <code>$${this.maxDailyLossUsd}</code>`;

    logFailure({
      slaveAccountId: accountId,
      contractId:     'N/A',
      action:         'Sell',
      qty:            0,
      orderId:        'daily-loss-guard',
      error:          `Daily loss limit reached: ${reason}`,
    });

    await sendAlert(
      `<b>⛔ Daily Loss Limit Reached — Slave Locked</b>\n` +
      `Slave: <code>${accountId}</code>\n` +
      `${limitLine}\n` +
      `No further trades will be copied to this account today.`,
    );
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}
