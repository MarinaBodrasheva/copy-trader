import axios from 'axios';
import { config } from '../config/index.js';
import type { AccountId, Action, ContractId } from '../types.js';

export interface CopyFailureParams {
  slaveAccountId: AccountId;
  contractId:     ContractId;
  action:         Action;
  qty:            number;
  error:          string;
}

export async function sendAlert(message: string): Promise<void> {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id:    chatId,
      text:       message,
      parse_mode: 'HTML',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Alerter] Failed to send Telegram alert:', msg);
  }
}

export async function alertCopyFailure(params: CopyFailureParams): Promise<void> {
  const { slaveAccountId, contractId, action, qty, error } = params;

  await sendAlert(
    `<b>CopyTrader — Failed Copy</b>\n` +
    `Slave account: <code>${slaveAccountId}</code>\n` +
    `Contract: <code>${contractId}</code>\n` +
    `Action: <code>${action}</code>  Qty: <code>${qty}</code>\n` +
    `Error: ${error}`,
  );
}
