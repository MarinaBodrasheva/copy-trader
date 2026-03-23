import axios from 'axios';
import { config } from '../config/index.js';

// Token store per account (if using per-account auth in the future)
// For now one shared token since all accounts share one Tradovate login
let accessToken = null;
let tokenExpiry = null;

export async function authenticate() {
  const res = await axios.post(`${config.restBase}/auth/accesstokenrequest`, {
    name: config.credentials.name,
    password: config.credentials.password,
    appId: config.credentials.appId,
    appVersion: config.credentials.appVersion,
    cid: config.credentials.cid,
    sec: config.credentials.sec,
    deviceId: 'copy-trader-node',
  });

  accessToken = res.data['access-token'];
  // Tradovate tokens expire after ~80 minutes; refresh at 70 min
  tokenExpiry = Date.now() + 70 * 60 * 1000;

  console.log('[Auth] Authenticated successfully');
  return accessToken;
}

export async function getToken() {
  if (!accessToken || Date.now() >= tokenExpiry) {
    await authenticate();
  }
  return accessToken;
}

export async function placeMarketOrder({ accountId, symbol, action, orderQty }) {
  const token = await getToken();

  const res = await axios.post(
    `${config.restBase}/order/placeorder`,
    {
      accountSpec: String(accountId),
      accountId,
      action,          // "Buy" or "Sell"
      symbol,
      orderQty,
      orderType: 'Market',
      isAutomated: true,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return res.data;
}

export async function getAccounts() {
  const token = await getToken();
  const res = await axios.get(`${config.restBase}/account/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}
