import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IPositionTracker, Fill } from '../src/types.js';

vi.mock('../src/api/tradovate.js', () => ({ placeMarketOrder: vi.fn(), getPositions: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/services/FailureLogger.js',  () => ({ logFailure: vi.fn() }));
vi.mock('../src/services/Alerter.js',        () => ({ alertCopyFailure: vi.fn(), sendAlert: vi.fn() }));
vi.mock('../src/config/index.js',  () => ({ config: { masterAccountId: 1, slaveAccountIds: [2] } }));
vi.mock('../src/services/DailyLossGuard.js', () => ({
  DailyLossGuard: vi.fn().mockImplementation(() => ({ isLocked: vi.fn().mockReturnValue(false) })),
}));

import { CopyEngine } from '../src/services/CopyEngine.js';
import { DailyLossGuard } from '../src/services/DailyLossGuard.js';
import { placeMarketOrder, getPositions } from '../src/api/tradovate.js';
import { logFailure } from '../src/services/FailureLogger.js';
import { alertCopyFailure, sendAlert } from '../src/services/Alerter.js';

const MASTER = 1;
const SLAVE  = 2;

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return { orderId: 1, accountId: MASTER, contractId: 'ESM4', action: 'Buy', qty: 2, ...overrides };
}

function makeTracker(overrides: Partial<IPositionTracker> = {}): IPositionTracker {
  return {
    initialize:     vi.fn().mockResolvedValue(undefined),
    isClosingFill:  vi.fn().mockReturnValue(false),
    applyFill:      vi.fn(),
    getNetQty:      vi.fn().mockReturnValue(2),
    refreshAccount: vi.fn().mockResolvedValue(undefined),
    reconcile:      vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('CopyEngine', () => {
  let engine:  CopyEngine;
  let tracker: IPositionTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(placeMarketOrder).mockResolvedValue({ orderId: 'placed-1' });
    tracker = makeTracker();
    engine  = new CopyEngine(tracker);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Slave fill events ──────────────────────────────────────────────────────

  it('updates position tracker when a slave fill event arrives', async () => {
    await engine.onFill(makeFill({ accountId: SLAVE }));

    expect(tracker.applyFill).toHaveBeenCalledWith(SLAVE, 'ESM4', 'Buy', 2);
  });

  it('ignores slave fill events with missing fields', async () => {
    await engine.onFill({ orderId: 1, accountId: SLAVE, contractId: '', action: 'Buy', qty: 0 });

    expect(tracker.applyFill).not.toHaveBeenCalled();
  });

  it('ignores fill events from unrecognised accounts', async () => {
    await engine.onFill(makeFill({ accountId: 99 }));

    expect(placeMarketOrder).not.toHaveBeenCalled();
    expect(tracker.applyFill).not.toHaveBeenCalled();
  });

  // ── Master fill: basic copy ────────────────────────────────────────────────

  it('places a market order on the slave for each master fill', async () => {
    await engine.onFill(makeFill());

    expect(placeMarketOrder).toHaveBeenCalledOnce();
    expect(placeMarketOrder).toHaveBeenCalledWith({
      accountId: SLAVE, symbol: 'ESM4', action: 'Buy', orderQty: 2,
    });
  });

  it('updates the master position tracker on every master fill', async () => {
    await engine.onFill(makeFill());

    expect(tracker.applyFill).toHaveBeenCalledWith(MASTER, 'ESM4', 'Buy', 2);
  });

  it('does NOT optimistically update slave position after order placement', async () => {
    await engine.onFill(makeFill());

    expect(tracker.applyFill).not.toHaveBeenCalledWith(SLAVE, 'ESM4', 'Buy', 2);
  });

  it('deduplicates master fills with the same orderId', async () => {
    const fill = makeFill();
    await engine.onFill(fill);
    await engine.onFill(fill);

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  it('skips master fill with missing fields without throwing', async () => {
    await engine.onFill({ orderId: 2, accountId: MASTER, contractId: '', action: 'Buy', qty: 0 });

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  // ── Failure handling ───────────────────────────────────────────────────────

  it('logs and alerts when placeMarketOrder rejects', async () => {
    vi.mocked(placeMarketOrder).mockRejectedValue(new Error('API error'));

    await engine.onFill(makeFill());

    expect(logFailure).toHaveBeenCalledOnce();
    expect(alertCopyFailure).toHaveBeenCalledOnce();
  });

  // ── Close guard ────────────────────────────────────────────────────────────

  it('copies close to slave that has an open position', async () => {
    vi.useFakeTimers();
    vi.mocked(tracker.isClosingFill).mockReturnValue(true);
    vi.mocked(tracker.getNetQty)
      .mockReturnValueOnce(2)   // close guard: has position
      .mockReturnValueOnce(0);  // verify: flat

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  it('skips close and alerts when slave has no open position (prevents reverse trade)', async () => {
    vi.useFakeTimers();
    vi.mocked(tracker.isClosingFill).mockReturnValue(true);
    vi.mocked(tracker.getNetQty).mockReturnValue(0);

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(placeMarketOrder).not.toHaveBeenCalled();
    expect(logFailure).toHaveBeenCalledOnce();
    expect(alertCopyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ slaveAccountId: SLAVE, contractId: 'ESM4' }),
    );
  });

  // ── Post-close verification ────────────────────────────────────────────────

  it('does not run post-close verification for open fills', async () => {
    vi.mocked(tracker.isClosingFill).mockReturnValue(false);

    await engine.onFill(makeFill({ action: 'Buy' }));

    expect(tracker.refreshAccount).not.toHaveBeenCalled();
  });

  it('confirms slave is flat after close — no retry needed', async () => {
    vi.useFakeTimers();
    vi.mocked(tracker.isClosingFill).mockReturnValue(true);
    vi.mocked(tracker.getNetQty)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(0);

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(tracker.refreshAccount).toHaveBeenCalledWith(SLAVE);
    expect(placeMarketOrder).toHaveBeenCalledOnce();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('retries close once when slave still has position after initial attempt', async () => {
    vi.useFakeTimers();
    vi.mocked(tracker.isClosingFill).mockReturnValue(true);
    vi.mocked(tracker.getNetQty)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(0);

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(placeMarketOrder).toHaveBeenCalledTimes(2);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  // ── Daily loss guard ───────────────────────────────────────────────────────

  it('skips copy when slave is locked by daily loss guard', async () => {
    const lockedGuard = new DailyLossGuard([], 0, 0);
    vi.mocked(lockedGuard.isLocked).mockReturnValue(true);
    const engineWithGuard = new CopyEngine(tracker, lockedGuard);

    await engineWithGuard.onFill(makeFill());

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  it('copies normally when daily loss guard says account is not locked', async () => {
    const unlockedGuard = new DailyLossGuard([], 0, 0);
    vi.mocked(unlockedGuard.isLocked).mockReturnValue(false);
    const engineWithGuard = new CopyEngine(tracker, unlockedGuard);

    await engineWithGuard.onFill(makeFill());

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  // ── Slave enable / disable ─────────────────────────────────────────────────

  it('skips copy when slave is disabled via setSlaveEnabled', async () => {
    await engine.setSlaveEnabled(SLAVE, false);
    vi.mocked(placeMarketOrder).mockClear();

    await engine.onFill(makeFill());

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  it('flattens open positions when slave is disabled', async () => {
    vi.mocked(getPositions).mockResolvedValue([
      { accountId: SLAVE, contractId: 'ESM4', netPos: 2 },
    ]);

    await engine.setSlaveEnabled(SLAVE, false);

    expect(getPositions).toHaveBeenCalledWith(SLAVE);
    expect(placeMarketOrder).toHaveBeenCalledWith({
      accountId: SLAVE, symbol: 'ESM4', action: 'Sell', orderQty: 2,
    });
  });

  it('does not place orders when slave has no open positions on disable', async () => {
    vi.mocked(getPositions).mockResolvedValue([]);

    await engine.setSlaveEnabled(SLAVE, false);

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  it('copies again after re-enabling a disabled slave', async () => {
    await engine.setSlaveEnabled(SLAVE, false);
    await engine.setSlaveEnabled(SLAVE, true);
    vi.mocked(placeMarketOrder).mockClear();

    await engine.onFill(makeFill());

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  // ── Dynamic master ─────────────────────────────────────────────────────────

  it('routes fills from the new master after setMaster', async () => {
    engine.setMaster(SLAVE); // SLAVE (2) is now master

    // A fill from account 2 should now be treated as master fill
    await engine.onFill(makeFill({ accountId: SLAVE, orderId: 99 }));

    // Account 1 (old master) is now a slave — should receive the copy
    expect(placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: MASTER }),
    );
  });

  it('demoted master is automatically enabled as a slave', () => {
    // Simulate: SLAVE was previously disabled, now promoted to master
    engine['disabledSlaves'].add(SLAVE);
    engine.setMaster(SLAVE); // MASTER is now demoted to slave

    // MASTER was never disabled — should be enabled
    expect(engine.isSlaveEnabled(MASTER)).toBe(true);
  });

  it('demoted master stays enabled even if it was disabled before it became master', async () => {
    // Disable MASTER first (edge case: user disables, then promotes)
    engine['disabledSlaves'].add(MASTER);
    engine.setMaster(SLAVE); // MASTER demoted back to slave

    // setMaster should have cleared the disabled flag
    expect(engine.isSlaveEnabled(MASTER)).toBe(true);
  });

  // ── disableAllSlaves ───────────────────────────────────────────────────────

  it('disableAllSlaves disables all non-master accounts', () => {
    engine.disableAllSlaves();

    expect(engine.isSlaveEnabled(SLAVE)).toBe(false);
  });

  it('disableAllSlaves does not affect the master', () => {
    engine.disableAllSlaves();

    // Master is not in slave list — isSlaveEnabled should return true
    expect(engine.isSlaveEnabled(MASTER)).toBe(true);
  });

  it('does not copy after disableAllSlaves until slave is re-enabled', async () => {
    engine.disableAllSlaves();

    await engine.onFill(makeFill());

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  // ── setAccountIds ──────────────────────────────────────────────────────────

  it('getAllAccountIds returns master and all slaves', () => {
    expect(engine.getAllAccountIds()).toEqual([MASTER, SLAVE]);
  });

  it('getSlaveIds returns all accounts except the current master', () => {
    expect(engine.getSlaveIds()).toEqual([SLAVE]);
  });

  it('setAccountIds updates the tracked account list', () => {
    const SLAVE2 = 3;
    engine.setAccountIds([MASTER, SLAVE, SLAVE2]);

    expect(engine.getAllAccountIds()).toEqual([MASTER, SLAVE, SLAVE2]);
  });

  it('setAccountIds disables newly added accounts by default', () => {
    const SLAVE2 = 3;
    engine.setAccountIds([MASTER, SLAVE, SLAVE2]);

    // SLAVE2 is new — should be disabled
    expect(engine.isSlaveEnabled(SLAVE2)).toBe(false);
  });

  it('setAccountIds preserves existing enable/disable state', async () => {
    // Disable SLAVE first
    await engine.setSlaveEnabled(SLAVE, false);

    // Now update account list — SLAVE was already tracked, state should persist
    engine.setAccountIds([MASTER, SLAVE]);

    expect(engine.isSlaveEnabled(SLAVE)).toBe(false);
  });

  it('setAccountIds removes stale entries from disabled set', async () => {
    await engine.setSlaveEnabled(SLAVE, false);

    // Remove SLAVE from the account list entirely
    engine.setAccountIds([MASTER]);

    // Re-add SLAVE — should be treated as a new account (disabled by default)
    // and the old disabled entry should have been cleaned up
    engine.setAccountIds([MASTER, SLAVE]);

    expect(engine.isSlaveEnabled(SLAVE)).toBe(false); // disabled as a new account
    expect(engine.getAllAccountIds()).toContain(SLAVE);
  });

  it('setAccountIds does not disable the current master', () => {
    engine.setAccountIds([MASTER, SLAVE]);

    // Master should not appear in disabled set
    expect(engine.isSlaveEnabled(MASTER)).toBe(true);
  });

  it('copies to a newly added slave after setAccountIds', async () => {
    const SLAVE2 = 3;
    engine.setAccountIds([MASTER, SLAVE, SLAVE2]);
    // Explicitly enable SLAVE2 (new accounts start disabled)
    await engine.setSlaveEnabled(SLAVE2, true);

    await engine.onFill(makeFill({ orderId: 50 }));

    expect(placeMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: SLAVE2 }),
    );
  });

  it('does not copy to an account removed via setAccountIds', async () => {
    // Remove SLAVE from the tracked list
    engine.setAccountIds([MASTER]);

    await engine.onFill(makeFill({ orderId: 51 }));

    expect(placeMarketOrder).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: SLAVE }),
    );
  });

  it('sends critical alert after max retries with slave still open', async () => {
    vi.useFakeTimers();
    vi.mocked(tracker.isClosingFill).mockReturnValue(true);
    vi.mocked(tracker.getNetQty)
      .mockReturnValueOnce(2)
      .mockReturnValue(2);

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(sendAlert).toHaveBeenCalledOnce();
    expect(sendAlert).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
    expect(logFailure).toHaveBeenCalledOnce();
  });
});
