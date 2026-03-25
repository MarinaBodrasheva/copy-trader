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
const LIMIT  = 500;

function makeGuard(slaves = [SLAVE], limit = LIMIT) {
  return new DailyLossGuard(slaves, limit);
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
    const guard = makeGuard();
    expect(guard.isLocked(SLAVE)).toBe(false);
  });

  // ── initialize: below limit ────────────────────────────────────────────────

  it('does not lock account when P&L is within limit', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, realizedPnl: -100 });

    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(false);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  // ── initialize: at the limit ───────────────────────────────────────────────

  it('does not lock account when P&L equals the limit exactly', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, realizedPnl: -500 });

    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(false);
  });

  // ── initialize: exceeds limit ──────────────────────────────────────────────

  it('locks account and sends alert when P&L exceeds limit', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, realizedPnl: -600 });

    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(true);
    expect(sendAlertMock).toHaveBeenCalledOnce();
    expect(sendAlertMock).toHaveBeenCalledWith(expect.stringContaining('Daily Loss Limit'));
    expect(logFailureMock).toHaveBeenCalledOnce();
  });

  // ── alert sent only once per lock ─────────────────────────────────────────

  it('sends alert only once even if background check fires again while locked', async () => {
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, realizedPnl: -600 });

    const guard = makeGuard();
    await guard.initialize();

    // Advance past one background check interval
    await vi.advanceTimersByTimeAsync(60_000);
    guard.destroy();

    // getCashBalance should NOT be called on the second tick for already-locked account
    expect(getCashBalanceMock).toHaveBeenCalledOnce();
    expect(sendAlertMock).toHaveBeenCalledOnce();
  });

  // ── multiple slaves — independent ─────────────────────────────────────────

  it('locks only the slave that exceeded the limit, not others', async () => {
    getCashBalanceMock
      .mockResolvedValueOnce({ accountId: SLAVE,  realizedPnl: -600 }) // over limit
      .mockResolvedValueOnce({ accountId: SLAVE2, realizedPnl: -200 }); // within limit

    const guard = makeGuard([SLAVE, SLAVE2]);
    await guard.initialize();
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(true);
    expect(guard.isLocked(SLAVE2)).toBe(false);
  });

  // ── API error: does not lock ───────────────────────────────────────────────

  it('does not lock account when API call fails', async () => {
    getCashBalanceMock.mockRejectedValue(new Error('Network error'));

    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(false);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  // ── API returns null ───────────────────────────────────────────────────────

  it('does not lock account when API returns null balance', async () => {
    getCashBalanceMock.mockResolvedValue(null);

    const guard = makeGuard();
    await guard.initialize();
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(false);
  });

  // ── New trading day resets lock ────────────────────────────────────────────

  it('unlocks all accounts on a new trading day', async () => {
    // Start "today"
    const fixedNow = new Date('2026-03-25T10:00:00Z').getTime();
    vi.setSystemTime(fixedNow);

    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, realizedPnl: -600 });

    const guard = makeGuard();
    await guard.initialize();
    expect(guard.isLocked(SLAVE)).toBe(true);

    // Advance clock to next day and trigger background tick
    vi.setSystemTime(new Date('2026-03-26T00:01:00Z').getTime());
    getCashBalanceMock.mockResolvedValue({ accountId: SLAVE, realizedPnl: 0 }); // fresh day
    await vi.advanceTimersByTimeAsync(60_000);
    guard.destroy();

    expect(guard.isLocked(SLAVE)).toBe(false);
  });
});
