import 'dotenv/config';
import type { AccountId } from '../types.js';

interface Credentials {
  name:       string | undefined;
  password:   string | undefined;
  appId:      string;
  appVersion: string;
  cid:        string | undefined;
  sec:        string | undefined;
}

interface TelegramConfig {
  botToken: string;
  chatId:   string;
}

export interface AppConfig {
  env:            string;
  restBase:       string;
  wsUrl:          string;
  credentials:    Credentials;
  masterAccountId: AccountId;
  slaveAccountIds: AccountId[];
  telegram:       TelegramConfig;
}

const env = process.env.TRADOVATE_ENV ?? 'demo';

export const config: AppConfig = {
  env,
  restBase: env === 'live'
    ? 'https://live.tradovateapi.com/v1'
    : 'https://demo.tradovateapi.com/v1',
  wsUrl: env === 'live'
    ? 'wss://live.tradovateapi.com/v1/websocket'
    : 'wss://demo.tradovateapi.com/v1/websocket',

  credentials: {
    name:       process.env.TRADOVATE_USERNAME,
    password:   process.env.TRADOVATE_PASSWORD,
    appId:      process.env.TRADOVATE_APP_ID      ?? 'Sample App',
    appVersion: process.env.TRADOVATE_APP_VERSION ?? '1.0',
    cid:        process.env.TRADOVATE_CID,
    sec:        process.env.TRADOVATE_SEC,
  },

  masterAccountId: Number(process.env.MASTER_ACCOUNT_ID),
  slaveAccountIds: process.env.SLAVE_ACCOUNT_IDS
    ? process.env.SLAVE_ACCOUNT_IDS.split(',').map(id => Number(id.trim()))
    : [],

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId:   process.env.TELEGRAM_CHAT_ID   ?? '',
  },
};
