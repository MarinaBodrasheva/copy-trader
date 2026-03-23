import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures this variable is available when vi.mock is hoisted to the top of the file
const appendFileMock = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({
  default: {
    existsSync:  vi.fn().mockReturnValue(true),
    mkdirSync:   vi.fn(),
    appendFile:  appendFileMock,
  },
}));

import { logFailure } from './FailureLogger.js';

const SAMPLE = {
  slaveAccountId: 2,
  contractId:     'ESM4',
  action:         'Sell',
  qty:            2,
  orderId:        'ord-1',
  error:          'Insufficient margin',
};

describe('FailureLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendFileMock.mockImplementation((_path, _data, cb) => cb(null));
  });

  it('calls appendFile once per logFailure invocation', () => {
    logFailure(SAMPLE);
    expect(appendFileMock).toHaveBeenCalledOnce();
  });

  it('writes a valid JSON line (parseable, newline-terminated)', () => {
    logFailure(SAMPLE);

    const [, written] = appendFileMock.mock.calls[0];
    expect(written).toMatch(/\n$/);
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it('written entry contains all expected fields', () => {
    logFailure(SAMPLE);

    const [, written] = appendFileMock.mock.calls[0];
    const entry = JSON.parse(written);

    expect(entry).toMatchObject({
      slaveAccountId: 2,
      contractId:     'ESM4',
      action:         'Sell',
      qty:            2,
      orderId:        'ord-1',
      error:          'Insufficient margin',
    });
    expect(entry.timestamp).toBeDefined();
  });

  it('writes to the failures.jsonl log file path', () => {
    logFailure(SAMPLE);

    const [filePath] = appendFileMock.mock.calls[0];
    expect(filePath).toContain('failures.jsonl');
  });

  it('does not throw when appendFile reports a write error', () => {
    appendFileMock.mockImplementation((_path, _data, cb) => cb(new Error('disk full')));

    expect(() => logFailure(SAMPLE)).not.toThrow();
  });
});
