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

  // ── Basic copy ─────────────────────────────────────────────────────────────

  it('places a market order on the slave for each master fill', async () => {
    await engine.onMasterFill(makeFill());

    expect(placeMarketOrder).toHaveBeenCalledOnce();
    expect(placeMarketOrder).toHaveBeenCalledWith({
      accountId: SLAVE, symbol: 'ESM4', action: 'Buy', orderQty: 2,
    });
  });

  it('updates the slave position tracker after a successful order', async () => {
    await engine.onMasterFill(makeFill());

    expect(tracker.applyFill).toHaveBeenCalledWith(SLAVE, 'ESM4', 'Buy', 2);
  });

  it('updates the master position tracker on every fill', async () => {
    await engine.onMasterFill(makeFill());

    expect(tracker.applyFill).toHaveBeenCalledWith(MASTER, 'ESM4', 'Buy', 2);
  });

  it('ignores fills from non-master accounts', async () => {
    await engine.onMasterFill(makeFill({ accountId: 99 }));

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  it('deduplicates fills with the same orderId', async () => {
    const fill = makeFill();
    await engine.onMasterFill(fill);
    await engine.onMasterFill(fill);

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  it('skips fill with missing fields without throwing', async () => {
    await engine.onMasterFill({ orderId: 'x', accountId: MASTER, contractId: null, action: null, qty: null });

    expect(placeMarketOrder).not.toHaveBeenCalled();
  });

  // ── Failure handling ───────────────────────────────────────────────────────

  it('logs and alerts when placeMarketOrder rejects', async () => {
    placeMarketOrder.mockRejectedValue(new Error('API error'));

    await engine.onMasterFill(makeFill());

    expect(logFailure).toHaveBeenCalledOnce();
    expect(alertCopyFailure).toHaveBeenCalledOnce();
  });

  it('does not update slave position tracker when order fails', async () => {
    placeMarketOrder.mockRejectedValue(new Error('API error'));

    await engine.onMasterFill(makeFill());

    // master fill must be tracked; slave must NOT be tracked on failure
    expect(tracker.applyFill).toHaveBeenCalledWith(MASTER, 'ESM4', 'Buy', 2);
    expect(tracker.applyFill).not.toHaveBeenCalledWith(SLAVE, 'ESM4', 'Buy', 2);
  });

  // ── Close guard ────────────────────────────────────────────────────────────

  it('copies close to slave that has an open position', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty
      .mockReturnValueOnce(2)   // close guard in _copyToSlave: has position → proceed
      .mockReturnValueOnce(0);  // post-close verify: slave is flat

    const promise = engine.onMasterFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(placeMarketOrder).toHaveBeenCalledOnce();
  });

  it('skips close and alerts when slave has no open position (prevents reverse trade)', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty.mockReturnValue(0); // slave is flat for all calls

    const promise = engine.onMasterFill(makeFill({ action: 'Sell' }));
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

    await engine.onMasterFill(makeFill({ action: 'Buy' }));

    expect(tracker.refreshAccount).not.toHaveBeenCalled();
  });

  it('confirms slave is flat after close — no retry needed', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty
      .mockReturnValueOnce(2)   // close guard
      .mockReturnValueOnce(0);  // verify: slave is flat

    const promise = engine.onMasterFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    expect(tracker.refreshAccount).toHaveBeenCalledWith(SLAVE);
    expect(placeMarketOrder).toHaveBeenCalledOnce(); // initial only, no retry
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('retries close once when slave still has position after initial attempt', async () => {
    vi.useFakeTimers();
    tracker.isClosingFill.mockReturnValue(true);
    tracker.getNetQty
      .mockReturnValueOnce(2)   // close guard
      .mockReturnValueOnce(2)   // verify attempt 1: still open → retry
      .mockReturnValueOnce(0);  // verify attempt 2: flat → done

    const promise = engine.onMasterFill(makeFill({ action: 'Sell' }));
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

    const promise = engine.onMasterFill(makeFill({ action: 'Sell' }));
    await vi.advanceTimersByTimeAsync(3000); // initial delay  → attempt 1 (retry)
    await vi.advanceTimersByTimeAsync(3000); // after retry 1  → attempt 2 (retry)
    await vi.advanceTimersByTimeAsync(3000); // after retry 2  → attempt 3 (critical)
    await promise;

    expect(sendAlert).toHaveBeenCalledOnce();
    expect(sendAlert).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
    expect(logFailure).toHaveBeenCalledOnce();
  });
});
