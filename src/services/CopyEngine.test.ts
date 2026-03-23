import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IPositionTracker, Fill } from '../types.js';

vi.mock('../api/tradovate.js', () => ({ placeMarketOrder: vi.fn() }));
vi.mock('./FailureLogger.js',  () => ({ logFailure: vi.fn() }));
vi.mock('./Alerter.js',        () => ({ alertCopyFailure: vi.fn(), sendAlert: vi.fn() }));
vi.mock('../config/index.js',  () => ({ config: { masterAccountId: 1, slaveAccountIds: [2] } }));

import { CopyEngine } from './CopyEngine.js';
import { placeMarketOrder } from '../api/tradovate.js';
import { logFailure } from './FailureLogger.js';
import { alertCopyFailure, sendAlert } from './Alerter.js';

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
