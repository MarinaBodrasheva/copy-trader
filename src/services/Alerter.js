import axios from 'axios';
import { config } from '../config/index.js';

/**
 * Sends a Telegram message.
 * Silently skips if TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are not configured.
 */
export async function sendAlert(message) {
  const { botToken, chatId } = config.telegram;

  if (!botToken || !chatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.error('[Alerter] Failed to send Telegram alert:', err.message);
  }
}

/**
 * Builds and sends a failed-copy alert.
 */
export async function alertCopyFailure({ slaveAccountId, contractId, action, qty, error }) {
  const msg =
    `<b>CopyTrader — Failed Copy</b>\n` +
    `Slave account: <code>${slaveAccountId}</code>\n` +
    `Contract: <code>${contractId}</code>\n` +
    `Action: <code>${action}</code>  Qty: <code>${qty}</code>\n` +
    `Error: ${error}`;

  await sendAlert(msg);
}
