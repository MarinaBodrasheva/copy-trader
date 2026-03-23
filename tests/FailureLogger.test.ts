import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FailureLogEntry } from '../src/types.js';

const appendFileMock = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  default: {
    existsSync:  vi.fn().mockReturnValue(true),
    mkdirSync:   vi.fn(),
    appendFile:  appendFileMock,
  },
}));

import { logFailure } from '../src/services/FailureLogger.js';

const SAMPLE: FailureLogEntry = {
  slaveAccountId: 2,
  contractId:     'ESM4',
  action:         'Sell',
  qty:            2,
  orderId:        1,
  error:          'Insufficient margin',
};

describe('FailureLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendFileMock.mockImplementation(
      (_path: string, _data: string, cb: (err: Error | null) => void) => cb(null),
    );
  });

  it('calls appendFile once per logFailure invocation', () => {
    logFailure(SAMPLE);
    expect(appendFileMock).toHaveBeenCalledOnce();
  });

  it('writes a valid JSON line (parseable, newline-terminated)', () => {
    logFailure(SAMPLE);

    const [, written] = appendFileMock.mock.calls[0] as [string, string];
    expect(written).toMatch(/\n$/);
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it('written entry contains all expected fields', () => {
    logFailure(SAMPLE);

    const [, written] = appendFileMock.mock.calls[0] as [string, string];
    const entry = JSON.parse(written) as Record<string, unknown>;

    expect(entry).toMatchObject({
      slaveAccountId: 2,
      contractId:     'ESM4',
      action:         'Sell',
      qty:            2,
      orderId:        1,
      error:          'Insufficient margin',
    });
    expect(entry.timestamp).toBeDefined();
  });

  it('writes to the failures.jsonl log file path', () => {
    logFailure(SAMPLE);

    const [filePath] = appendFileMock.mock.calls[0] as [string];
    expect(filePath).toContain('failures.jsonl');
  });

  it('does not throw when appendFile reports a write error', () => {
    appendFileMock.mockImplementation(
      (_path: string, _data: string, cb: (err: Error | null) => void) => cb(new Error('disk full')),
    );

    expect(() => logFailure(SAMPLE)).not.toThrow();
  });
});
