import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

function makeFill(overrides = {}) {
  return { orderId: 'ord-1', accountId: MASTER, contractId: 'ESM4', action: 'Buy', qty: 2, ...overrides };
}

function makeTracker(overrides = {}) {
  return {
    isClosingFill:  vi.fn().mockReturnValue(false),
    applyFill:      vi.fn(),
    getNetQty:      vi.fn().mockReturnValue(2),
    refreshAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('CopyEngine', () => {
  let engine, tracker;

  beforeEach(() => {
    vi.clearAllMocks();
    placeMarketOrder.mockResolvedValue({ orderId: 'placed-1' });
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
    await engine.onFill({ accountId: SLAVE, contractId: null, action: null, qty: null });

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

    // Slave position must only be updated via an actual fill event, not order placement
    expect(tracker.applyFill).not.toHaveBeenCalledWith(SLAVE, 'ESM4', 'Buy', 2);
  });

  it('deduplicates master fills with the same orderId', async () => {
    const fill = makeFill();
    await engine.onFill(fill);
    await engine.onFill(fill);

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  it('skips master fill with missing fields without throwing', async () => {
    await engine.onFill({ orderId: 'x', accountId: MASTER, contractId: null, action: null, qty: null });

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  // ── Failure handling ───────────────────────────────────────────────────────

  it('logs and alerts when placeMarketOrder rejects', async () => {
    placeMarketOrder.mockRejectedValue(new Error('API error'));

    await engine.onFill(makeFill());

    expect(logFailure).toHaveBeenCalledOnce();
    expect(alertCopyFailure).toHaveBeenCalledOnce();
  });

  // ── Close guard ────────────────────────────────────────────────────────────

  it('copies close to slave that has an open position', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty
      .mockReturnValueOnce(2)   // close guard: slave has position → proceed
      .mockReturnValueOnce(0);  // post-close verify: slave is flat

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  it('skips close and alerts when slave has no open position (prevents reverse trade)', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty.mockReturnValue(0); // slave is flat for all calls

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(placeMarketOrder).not.toHaveBeenCalled();
    expect(logFailure).toHaveBeenCalledOnce();
    expect(alertCopyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ slaveAccountId: SLAVE, contractId: 'ESM4' })
    );
  });

  // ── Post-close verification ────────────────────────────────────────────────

  it('does not run post-close verification for open fills', async () => {
    tracker.isClosingFill.mockReturnValue(false);

    await engine.onFill(makeFill({ action: 'Buy' }));

    expect(tracker.refreshAccount).not.toHaveBeenCalled();
  });

  it('confirms slave is flat after close — no retry needed', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty
      .mockReturnValueOnce(2)   // close guard
      .mockReturnValueOnce(0);  // verify: slave is flat

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(tracker.refreshAccount).toHaveBeenCalledWith(SLAVE);
    expect(placeMarketOrder).toHaveBeenCalledOnce(); // no retry
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('retries close once when slave still has position after initial attempt', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty
      .mockReturnValueOnce(2)   // close guard
      .mockReturnValueOnce(2)   // verify attempt 1: still open → retry
      .mockReturnValueOnce(0);  // verify attempt 2: flat → done

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000); // initial verify delay
    await vi.advanceTimersByTimeAsync(3000); // delay after retry 1
    await promise;

    expect(placeMarketOrder).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('sends critical alert after max retries with slave still open', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty
      .mockReturnValueOnce(2)  // close guard
      .mockReturnValue(2);     // always open in every verify attempt

    const promise = engine.onFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000); // initial delay  → attempt 1 (retry)
    await vi.advanceTimersByTimeAsync(3000); // after retry 1  → attempt 2 (retry)
    await vi.advanceTimersByTimeAsync(3000); // after retry 2  → attempt 3 (critical)
    await promise;

    expect(sendAlert).toHaveBeenCalledOnce();
    expect(sendAlert).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
    expect(logFailure).toHaveBeenCalledOnce();
  });
});
