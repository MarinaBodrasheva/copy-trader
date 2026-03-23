import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/tradovate.js', () => ({ getPositions: vi.fn() }));
vi.mock('./Alerter.js',        () => ({ sendAlert: vi.fn() }));
vi.mock('../config/index.js',  () => ({ config: { masterAccountId: 1, slaveAccountIds: [2] } }));

import { PositionTracker } from './PositionTracker.js';
import { getPositions } from '../api/tradovate.js';
import { sendAlert } from './Alerter.js';
import type { Position } from '../types.js';

function pos(contractId: string, netPos: number, accountId = 1): Position {
  return { contractId, netPos, accountId };
}

describe('PositionTracker', () => {
  let tracker: PositionTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new PositionTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── isClosingFill ──────────────────────────────────────────────────────────

  describe('isClosingFill', () => {
    it('returns true for Sell when account is long', () => {
      tracker.applyFill(1, 'ESM4', 'Buy', 2);
      expect(tracker.isClosingFill(1, 'ESM4', 'Sell')).toBe(true);
    });

    it('returns true for Buy when account is short', () => {
      tracker.applyFill(1, 'ESM4', 'Sell', 2);
      expect(tracker.isClosingFill(1, 'ESM4', 'Buy')).toBe(true);
    });

    it('returns false for Buy when account is flat', () => {
      expect(tracker.isClosingFill(1, 'ESM4', 'Buy')).toBe(false);
    });

    it('returns false for Sell when account is flat', () => {
      expect(tracker.isClosingFill(1, 'ESM4', 'Sell')).toBe(false);
    });

    it('returns false for Buy when account is already long (adding to position)', () => {
      tracker.applyFill(1, 'ESM4', 'Buy', 2);
      expect(tracker.isClosingFill(1, 'ESM4', 'Buy')).toBe(false);
    });
  });

  // ── applyFill ──────────────────────────────────────────────────────────────

  describe('applyFill', () => {
    it('increases net qty on Buy', () => {
      tracker.applyFill(1, 'ESM4', 'Buy', 3);
      expect(tracker.getNetQty(1, 'ESM4')).toBe(3);
    });

    it('decreases net qty on Sell', () => {
      tracker.applyFill(1, 'ESM4', 'Buy', 4);
      tracker.applyFill(1, 'ESM4', 'Sell', 2);
      expect(tracker.getNetQty(1, 'ESM4')).toBe(2);
    });

    it('removes entry when position goes exactly flat', () => {
      tracker.applyFill(1, 'ESM4', 'Buy', 2);
      tracker.applyFill(1, 'ESM4', 'Sell', 2);
      expect(tracker.getNetQty(1, 'ESM4')).toBe(0);
    });

    it('tracks positions independently per account', () => {
      tracker.applyFill(1, 'ESM4', 'Buy', 2);
      tracker.applyFill(2, 'ESM4', 'Buy', 5);
      expect(tracker.getNetQty(1, 'ESM4')).toBe(2);
      expect(tracker.getNetQty(2, 'ESM4')).toBe(5);
    });

    it('tracks positions independently per contract', () => {
      tracker.applyFill(1, 'ESM4', 'Buy', 2);
      tracker.applyFill(1, 'NQM4', 'Buy', 1);
      expect(tracker.getNetQty(1, 'ESM4')).toBe(2);
      expect(tracker.getNetQty(1, 'NQM4')).toBe(1);
    });
  });

  // ── getNetQty ──────────────────────────────────────────────────────────────

  it('returns 0 for unknown account', () => {
    expect(tracker.getNetQty(99, 'ESM4')).toBe(0);
  });

  it('returns 0 for unknown contract on a known account', () => {
    tracker.applyFill(1, 'ESM4', 'Buy', 2);
    expect(tracker.getNetQty(1, 'NQM4')).toBe(0);
  });

  // ── initialize ─────────────────────────────────────────────────────────────

  it('loads positions from API for master and all slave accounts', async () => {
    vi.useFakeTimers();
    vi.mocked(getPositions).mockResolvedValue([pos('ESM4', 3)]);

    await tracker.initialize();

    expect(getPositions).toHaveBeenCalledTimes(2);
    expect(tracker.getNetQty(1, 'ESM4')).toBe(3);
    expect(tracker.getNetQty(2, 'ESM4')).toBe(3);
  });

  // ── reconcile ──────────────────────────────────────────────────────────────

  describe('reconcile', () => {
    it('sends alert when slave position differs from master', async () => {
      vi.mocked(getPositions)
        .mockResolvedValueOnce([pos('ESM4', 2)])
        .mockResolvedValueOnce([pos('ESM4', 1, 2)]);

      await tracker.reconcile();

      expect(sendAlert).toHaveBeenCalledOnce();
      expect(sendAlert).toHaveBeenCalledWith(expect.stringContaining('Mismatch'));
    });

    it('does not alert when positions match', async () => {
      vi.mocked(getPositions)
        .mockResolvedValueOnce([pos('ESM4', 2)])
        .mockResolvedValueOnce([pos('ESM4', 2, 2)]);

      await tracker.reconcile();

      expect(sendAlert).not.toHaveBeenCalled();
    });

    it('alerts when slave is flat but master has an open position', async () => {
      vi.mocked(getPositions)
        .mockResolvedValueOnce([pos('ESM4', 2)])
        .mockResolvedValueOnce([]);

      await tracker.reconcile();

      expect(sendAlert).toHaveBeenCalledOnce();
    });

    it('alerts when master is flat but slave still has a position', async () => {
      vi.mocked(getPositions)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([pos('ESM4', 2, 2)]);

      await tracker.reconcile();

      expect(sendAlert).toHaveBeenCalledOnce();
    });

    it('does not alert when both master and slave are flat', async () => {
      vi.mocked(getPositions)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await tracker.reconcile();

      expect(sendAlert).not.toHaveBeenCalled();
    });
  });

  // ── refreshAccount ─────────────────────────────────────────────────────────

  it('updates local position state from API on refresh', async () => {
    vi.mocked(getPositions).mockResolvedValue([pos('ESM4', 5)]);

    await tracker.refreshAccount(1);

    expect(tracker.getNetQty(1, 'ESM4')).toBe(5);
  });

  it('clears stale local positions when API reports account is flat', async () => {
    tracker.applyFill(1, 'ESM4', 'Buy', 2);
    vi.mocked(getPositions).mockResolvedValue([]);

    await tracker.refreshAccount(1);

    expect(tracker.getNetQty(1, 'ESM4')).toBe(0);
  });
});
