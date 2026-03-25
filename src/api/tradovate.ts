import axios from 'axios';
import { config } from '../config/index.js';
import type { AccountId, CashBalance, PlaceOrderParams, PlaceOrderResponse, Position } from '../types.js';

let accessToken: string | null = null;
let tokenExpiry: number | null = null;

export async function authenticate(): Promise<string> {
  const res = await axios.post<{ 'access-token': string }>(
    `${config.restBase}/auth/accesstokenrequest`,
    {
      name:       config.credentials.name,
      password:   config.credentials.password,
      appId:      config.credentials.appId,
      appVersion: config.credentials.appVersion,
      cid:        config.credentials.cid,
      sec:        config.credentials.sec,
      deviceId:   'copy-trader-node',
    },
  );

  accessToken = res.data['access-token'];
  // Tradovate tokens expire after ~80 minutes; refresh at 70 min
  tokenExpiry = Date.now() + 70 * 60 * 1000;

  console.log('[Auth] Authenticated successfully');
  return accessToken;
}

export async function getToken(): Promise<string> {
  if (!accessToken || Date.now() >= (tokenExpiry ?? 0)) {
    await authenticate();
  }
  return accessToken!;
}

export async function placeMarketOrder(params: PlaceOrderParams): Promise<PlaceOrderResponse> {
  const { accountId, symbol, action, orderQty } = params;
  const token = await getToken();

  const res = await axios.post<PlaceOrderResponse>(
    `${config.restBase}/order/placeorder`,
    {
      accountSpec: String(accountId),
      accountId,
      action,
      symbol,
      orderQty,
      orderType:   'Market',
      isAutomated: true,
    },
    { headers: { Authorization: `Bearer ${token}` } },
  );

  return res.data;
}

export async function getAccounts(): Promise<unknown[]> {
  const token = await getToken();
  const res = await axios.get<unknown[]>(`${config.restBase}/account/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

export async function getPositions(accountId: AccountId): Promise<Position[]> {
  const token = await getToken();
  const res = await axios.get<Position[]>(`${config.restBase}/position/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Tradovate returns all positions for the user — filter to the requested account
  return (res.data ?? []).filter(p => p.accountId === accountId);
}

export async function getCashBalance(accountId: AccountId): Promise<CashBalance | null> {
  const token = await getToken();
  const res = await axios.get<CashBalance[]>(`${config.restBase}/cashBalance/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (res.data ?? []).find(b => b.accountId === accountId) ?? null;
}
