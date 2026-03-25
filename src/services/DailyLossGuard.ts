import { getCashBalance } from '../api/tradovate.js';
import { logFailure } from './FailureLogger.js';
import { sendAlert } from './Alerter.js';
import type { AccountId } from '../types.js';

const CHECK_INTERVAL_MS = 60_000; // check every minute

export class DailyLossGuard {
  private readonly lockedAccounts  = new Set<AccountId>();
  private readonly alertedAccounts = new Set<AccountId>(); // send alert only once per lock
  private checkInterval?: ReturnType<typeof setInterval>;
  private currentTradeDate = '';

  constructor(
    private readonly slaveAccountIds: AccountId[],
    private readonly maxDailyLossUsd: number,
  ) {}

  /** Fetch current P&L for all slaves and start background polling. */
  async initialize(): Promise<void> {
    this.currentTradeDate = todayUtc();
    await this._checkAll();
    this.checkInterval = setInterval(() => void this._tick(), CHECK_INTERVAL_MS);
  }

  /** Fast synchronous check — used before every copy attempt. */
  isLocked(accountId: AccountId): boolean {
    return this.lockedAccounts.has(accountId);
  }

  /** Stop the background interval (call on shutdown). */
  destroy(): void {
    if (this.checkInterval !== undefined) clearInterval(this.checkInterval);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    const today = todayUtc();
    if (today !== this.currentTradeDate) {
      // New trading day — reset all locks
      this.currentTradeDate = today;
      this.lockedAccounts.clear();
      this.alertedAccounts.clear();
      console.log('[DailyLossGuard] New trading day — all slave accounts unlocked');
    }
    await this._checkAll();
  }

  private async _checkAll(): Promise<void> {
    await Promise.all(this.slaveAccountIds.map(id => this._checkAccount(id)));
  }

  private async _checkAccount(accountId: AccountId): Promise<void> {
    // Skip API call if already locked — no point re-fetching
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

    const { realizedPnl } = balance;

    if (realizedPnl < -this.maxDailyLossUsd) {
      this.lockedAccounts.add(accountId);
      console.warn(
        `[DailyLossGuard] ⛔ Slave ${accountId} locked — ` +
        `daily loss $${Math.abs(realizedPnl).toFixed(2)} exceeds limit $${this.maxDailyLossUsd}`,
      );

      if (!this.alertedAccounts.has(accountId)) {
        this.alertedAccounts.add(accountId);

        logFailure({
          slaveAccountId: accountId,
          contractId:     'N/A',
          action:         'Sell',
          qty:            0,
          orderId:        'daily-loss-guard',
          error:          `Daily loss limit reached: $${Math.abs(realizedPnl).toFixed(2)} / $${this.maxDailyLossUsd}`,
        });

        await sendAlert(
          `<b>⛔ Daily Loss Limit Reached — Slave Locked</b>\n` +
          `Slave: <code>${accountId}</code>\n` +
          `Realized P&amp;L today: <code>-$${Math.abs(realizedPnl).toFixed(2)}</code>\n` +
          `Limit: <code>$${this.maxDailyLossUsd}</code>\n` +
          `No further trades will be copied to this account today.`,
        );
      }
    }
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}
