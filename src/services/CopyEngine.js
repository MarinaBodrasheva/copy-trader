import { placeMarketOrder } from '../api/tradovate.js';
import { config } from '../config/index.js';
import { logFailure } from './FailureLogger.js';
import { alertCopyFailure } from './Alerter.js';

export class CopyEngine {
  constructor() {
    this.slaveAccountIds = config.slaveAccountIds;
    // Track recently processed fills to avoid duplicates
    this.processedFills = new Set();
  }

  async onMasterFill(fill) {
    // Deduplicate: same fill can arrive more than once
    if (this.processedFills.has(fill.orderId)) return;
    this.processedFills.add(fill.orderId);

    // Only handle fills from the master account
    if (fill.accountId !== config.masterAccountId) return;

    const { contractId, action, qty } = fill;

    if (!contractId || !action || !qty) {
      console.warn('[CopyEngine] Incomplete fill data, skipping:', fill);
      return;
    }

    console.log(
      `[CopyEngine] Master fill detected — ${action} ${qty}x contractId:${contractId}`
    );

    // Fire all slave orders in parallel
    const results = await Promise.allSettled(
      this.slaveAccountIds.map((accountId) =>
        placeMarketOrder({
          accountId,
          symbol: contractId,
          action,
          orderQty: qty,
        }).then((res) => {
          console.log(`[CopyEngine] ✓ Slave ${accountId} order placed:`, res.orderId || res);
          return { accountId, status: 'ok', res };
        })
      )
    );

    // Log any failures without crashing
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const accountId = this.slaveAccountIds[i];
        const error =
          result.reason?.response?.data
            ? JSON.stringify(result.reason.response.data)
            : result.reason?.message ?? 'Unknown error';

        console.error(`[CopyEngine] ✗ Failed to copy to slave ${accountId}:`, error);

        logFailure({ slaveAccountId: accountId, contractId, action, qty, orderId: fill.orderId, error });
        alertCopyFailure({ slaveAccountId: accountId, contractId, action, qty, error });
      }
    }

    // Cleanup old processed fills (keep last 1000)
    if (this.processedFills.size > 1000) {
      const first = this.processedFills.values().next().value;
      this.processedFills.delete(first);
    }
  }
}
