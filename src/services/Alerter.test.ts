import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('../config/index.js', () => ({
  config: { telegram: { botToken: 'test-token', chatId: '99999' } },
}));

import { sendAlert, alertCopyFailure } from './Alerter.js';
import axios from 'axios';
import { config } from '../config/index.js';

describe('Alerter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(axios.post).mockResolvedValue({ data: { ok: true } });
    config.telegram.botToken = 'test-token';
    config.telegram.chatId   = '99999';
  });

  // ── sendAlert ──────────────────────────────────────────────────────────────

  it('POSTs to the correct Telegram sendMessage URL', async () => {
    await sendAlert('hello');

    expect(axios.post).toHaveBeenCalledOnce();
    expect(vi.mocked(axios.post).mock.calls[0][0]).toContain('test-token/sendMessage');
  });

  it('sends the message text and chat_id in the request body', async () => {
    await sendAlert('hello');

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ chat_id: '99999', text: 'hello' }),
    );
  });

  it('skips sending when botToken is not configured', async () => {
    config.telegram.botToken = '';

    await sendAlert('hello');

    expect(axios.post).not.toHaveBeenCalled();
  });

  it('skips sending when chatId is not configured', async () => {
    config.telegram.chatId = '';

    await sendAlert('hello');

    expect(axios.post).not.toHaveBeenCalled();
  });

  it('does not throw when the Telegram API request fails', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('Network error'));

    await expect(sendAlert('hello')).resolves.toBeUndefined();
  });

  // ── alertCopyFailure ───────────────────────────────────────────────────────

  it('includes slave account, contract, action, qty and error in the message', async () => {
    await alertCopyFailure({
      slaveAccountId: 42,
      contractId:     'NQM4',
      action:         'Buy',
      qty:            1,
      error:          'Margin exceeded',
    });

    const [, body] = vi.mocked(axios.post).mock.calls[0] as [string, { text: string }];
    expect(body.text).toContain('42');
    expect(body.text).toContain('NQM4');
    expect(body.text).toContain('Buy');
    expect(body.text).toContain('1');
    expect(body.text).toContain('Margin exceeded');
  });
});
