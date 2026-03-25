import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getCashBalanceMock, logFailureMock, sendAlertMock } = vi.hoisted(() => ({
  getCashBalanceMock: vi.fn(),
  logFailureMock:     vi.fn(),
  sendAlertMock:      vi.fn(),
}));

vi.mock('../src/api/tradovate.js',          () => ({ getCashBalance: getCashBalanceMock }));
vi.mock('../src/services/FailureLogger.js', () => ({ logFailure: logFailureMock }));
vi.mock('../src/services/Alerter.js',       () => ({ sendAlert: sendAlertMock }));

import { DailyLossGuard } from '../src/services/DailyLossGuard.js';

const SLAVE  = 2;
const SLAVE2 = 3;
const REALIZED_LIMIT = 500;
const TOTAL_LIMIT    = 600;

function makeGuard(slaves = [SLAVE], realized = REALIZED_LIMIT, total = 0) {
  return new DailyLossGuard(slaves, realized, total);
}

describe('DailyLossGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── isLocked before initialize ─────────────────────────────────────────────

  it('is not locked before any check', () => {
    expect(makeGuard().isLocked(SLAVE)).toBe(false);
  });

  // ── REST path: initialize ──────────────────────────────────────────────────

  it('does not lock when realized P&L is within limit', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: -100 });
    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();
    expect(guard.isLocked(SLAVE)).toBe(false);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('does not lock when realized P&L equals limit exactly', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: -500 });
    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();
    expect(guard.isLocked(SLAVE)).toBe(false);
  });

  it('locks and alerts when realized P&L exceeds limit (REST path)', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: -600 });
    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();
    expect(guard.isLocked(SLAVE)).toBe(true);
    expect(sendAlertMock).toHaveBeenCalledOnce();
    expect(sendAlertMock).toHaveBeenCalledWith(expect.stringContaining('Daily Loss Limit'));
    expect(logFailureMock).toHaveBeenCalledOnce();
  });

  it('locks when total (realized + open) exceeds total limit (REST path)', async () => {
    getCashBalanceMock.mockResolvedValue({
      accountId: SLAVE, amount: 50000, realizedPnl: -400, openPnL: -250,
    });
    const guard = makeGuard([SLAVE], 0, TOTAL_LIMIT); // only total limit active
    await guard.initialize();
    guard.destroy();
    expect(guard.isLocked(SLAVE)).toBe(true);
    expect(sendAlertMock).toHaveBeenCalledWith(expect.stringContaining('Total P'));
  });

  it('does not lock when only realized limit active and total exceeds it but realized does not', async () => {
    getCashBalanceMock.mockResolvedValue({
      accountId: SLAVE, amount: 50000, realizedPnl: -100, openPnL: -600,
    });
    const guard = makeGuard([SLAVE], REALIZED_LIMIT, 0); // realized-only, open ignored
    await guard.initialize();
    guard.destroy();
    expect(guard.isLocked(SLAVE)).toBe(false);
  });

  // ── WebSocket path: applyUpdate ────────────────────────────────────────────

  it('locks immediately when WS update breaches realized limit', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: 0 });
    const guard = makeGuard();
    await guard.initialize();

    guard.applyUpdate({ accountId: SLAVE, realizedPnl: -600 });
    await Promise.resolve();

    expect(guard.isLocked(SLAVE)).toBe(true);
    expect(sendAlertMock).toHaveBeenCalledOnce();
    guard.destroy();
  });

  it('locks immediately when WS update breaches total limit', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: -400 });
    const guard = makeGuard([SLAVE], 0, TOTAL_LIMIT);
    await guard.initialize();

    // Realized already -400, open P&L update pushes total past -600
    guard.applyUpdate({ accountId: SLAVE, openPnL: -250 });
    await Promise.resolve();

    expect(guard.isLocked(SLAVE)).toBe(true);
    expect(sendAlertMock).toHaveBeenCalledWith(expect.stringContaining('Total P'));
    guard.destroy();
  });

  it('does not lock when WS update is within limits', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: 0 });
    const guard = makeGuard();
    await guard.initialize();

    guard.applyUpdate({ accountId: SLAVE, realizedPnl: -100 });
    await Promise.resolve();

    expect(guard.isLocked(SLAVE)).toBe(false);
    guard.destroy();
  });

  it('ignores WS updates for unknown (non-slave) accounts', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: 0 });
    const guard = makeGuard([SLAVE]);
    await guard.initialize();

    guard.applyUpdate({ accountId: 999, realizedPnl: -9999 }); // not a slave
    await Promise.resolve();

    expect(guard.isLocked(999)).toBe(false);
    guard.destroy();
  });

  // ── Alert deduplication ────────────────────────────────────────────────────

  it('sends alert only once even when WS fires multiple breaching updates', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: 0 });
    const guard = makeGuard();
    await guard.initialize();

    guard.applyUpdate({ accountId: SLAVE, realizedPnl: -600 });
    guard.applyUpdate({ accountId: SLAVE, realizedPnl: -700 });
    await Promise.resolve();

    expect(sendAlertMock).toHaveBeenCalledOnce();
    guard.destroy();
  });

  it('sends alert only once even if REST safety-net fires again while locked', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: -600 });
    const guard = makeGuard();
    await guard.initialize();
    expect(guard.isLocked(SLAVE)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000); // trigger REST poll again
    guard.destroy();

    expect(getCashBalanceMock).toHaveBeenCalledOnce(); // skipped on second tick (already locked)
    expect(sendAlertMock).toHaveBeenCalledOnce();
  });

  // ── Multiple slaves ────────────────────────────────────────────────────────

  it('locks only the slave that exceeded the limit, not others', async () => {
    getCashBalanceMock
      .mockResolvedValueOnce({ accountId: SLAVE,  amount: 50000, realizedPnl: -600 })
      .mockResolvedValueOnce({ accountId: SLAVE2, amount: 25000, realizedPnl: -200 });

    const guard = makeGuard([SLAVE, SLAVE2]);
    await guard.initialize();
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(true);
    expect(guard.isLocked(SLAVE2)).toBe(false);
  });

  // ── Fault tolerance ────────────────────────────────────────────────────────

  it('does not lock when REST API call fails', async () => {
    getCashBalanceMock.mockRejectedValue(new Error('Network error'));
    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();
    expect(guard.isLocked(SLAVE)).toBe(false);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('does not lock when REST API returns null', async () => {
    getCashBalanceMock.mockResolvedValue(null);
    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();
    expect(guard.isLocked(SLAVE)).toBe(false);
  });

  // ── New trading day reset ──────────────────────────────────────────────────

  it('unlocks all accounts on a new trading day', async () => {
    vi.setSystemTime(new Date('2026-03-25T10:00:00Z'));
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: -600 });

    const guard = makeGuard();
    await guard.initialize();
    expect(guard.isLocked(SLAVE)).toBe(true);

    vi.setSystemTime(new Date('2026-03-26T00:01:00Z'));
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, amount: 50000, realizedPnl: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(false);
  });
});
