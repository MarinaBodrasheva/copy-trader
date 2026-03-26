import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAccountList, getCashBalance, getPositions, placeMarketOrder } from '../api/tradovate.js';
import type { CopyEngine } from '../services/CopyEngine.js';
import type { DailyLossGuard } from '../services/DailyLossGuard.js';
import type { AccountId, AccountSummary, CashBalanceUpdate } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Connection status ─────────────────────────────────────────────────────────

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

let connectionStatus: ConnectionStatus = 'connecting';
let connectionMessage = 'Connecting to Tradovate…';

export function setConnectionStatus(status: ConnectionStatus, message: string): void {
  connectionStatus = status;
  connectionMessage = message;
  if (status !== 'connected') cacheExpiry = 0; // don't serve stale data when offline
  console.log(`[Dashboard] Status: ${status} — ${message}`);
}

// ── In-memory store updated live by WebSocket cashBalance push events ─────────
const openPnlStore:     Map<AccountId, number> = new Map();
const realizedPnlStore: Map<AccountId, number> = new Map();

/** Called from TradovateSocket whenever a cashBalance WS event arrives. */
export function applyWsCashBalance(update: CashBalanceUpdate): void {
  if (update.openPnL     !== undefined) openPnlStore.set(update.accountId,     update.openPnL);
  if (update.realizedPnl !== undefined) realizedPnlStore.set(update.accountId, update.realizedPnl);
}

// Cache REST results for 5 s
const CACHE_TTL_MS = 5_000;
let cachedSummaries: AccountSummary[] = [];
let cacheExpiry = 0;

async function buildSummaries(engine: CopyEngine, guard?: DailyLossGuard): Promise<AccountSummary[]> {
  if (Date.now() < cacheExpiry) return cachedSummaries;

  const allAccountIds = engine.getAllAccountIds();

  // When not connected, skip API calls — return known accounts with whatever
  // data we have in the WS store (or zeros). The connection banner explains why.
  if (connectionStatus !== 'connected') {
    return allAccountIds.map(accountId => {
      const isMaster = accountId === engine.getMasterId();
      return {
        accountId,
        name:        String(accountId),
        role:        isMaster ? 'master' : 'slave',
        balance:     0,
        realizedPnl: realizedPnlStore.get(accountId) ?? 0,
        openPnL:     openPnlStore.get(accountId)     ?? null,
        isLocked:    guard?.isLocked(accountId) ?? false,
        enabled:     isMaster ? true : engine.isSlaveEnabled(accountId),
      };
    });
  }

  const [accounts, ...balances] = await Promise.all([
    getAccountList(),
    ...allAccountIds.map(id => getCashBalance(id).catch(() => null)),
  ]);

  const nameMap = new Map(accounts.map(a => [a.id, a.name]));

  cachedSummaries = allAccountIds.map((accountId, i) => {
    const bal      = balances[i];
    const isMaster = accountId === engine.getMasterId();
    return {
      accountId,
      name:        nameMap.get(accountId) ?? String(accountId),
      role:        isMaster ? 'master' : 'slave',
      balance:     bal?.amount ?? 0,
      realizedPnl: realizedPnlStore.get(accountId) ?? bal?.realizedPnl ?? 0,
      openPnL:     openPnlStore.get(accountId)     ?? bal?.openPnL     ?? null,
      isLocked:    guard?.isLocked(accountId) ?? false,
      enabled:     isMaster ? true : engine.isSlaveEnabled(accountId),
    };
  });

  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cachedSummaries;
}

export function startDashboard(port: number, engine: CopyEngine, guard?: DailyLossGuard): void {
  const app = express();
  app.use(express.json());

  const publicDir = path.resolve(__dirname, '../../public');
  app.use(express.static(publicDir));

  // Derived dynamically so it picks up accounts fetched from the API at runtime
  const isKnownAccount = (id: AccountId) => engine.getAllAccountIds().includes(id);

  // ── Connection status ──────────────────────────────────────────────────────

  app.get('/api/status', (_req, res) => {
    res.json({ status: connectionStatus, message: connectionMessage });
  });

  // ── Accounts summary ───────────────────────────────────────────────────────

  app.get('/api/accounts', (_req, res) => {
    buildSummaries(engine, guard)
      .then(data => res.json(data))
      .catch(err => {
        console.error('[Dashboard] /api/accounts error:', (err as Error).message);
        res.status(500).json({ error: 'Failed to fetch account data' });
      });
  });

  // ── Set master ─────────────────────────────────────────────────────────────

  app.post('/api/master/:accountId', (req, res) => {
    const accountId = Number(req.params['accountId']);
    if (!isKnownAccount(accountId)) {
      res.status(400).json({ error: 'Unknown account' }); return;
    }
    engine.setMaster(accountId);
    cacheExpiry = 0;
    res.json({ masterId: accountId });
  });

  // ── Enable / disable slave ─────────────────────────────────────────────────

  app.post('/api/accounts/:accountId/enable', (req, res) => {
    const accountId = Number(req.params['accountId']);
    if (!isKnownAccount(accountId)) {
      res.status(400).json({ error: 'Unknown account' }); return;
    }
    engine.setSlaveEnabled(accountId, true);
    cacheExpiry = 0;
    res.json({ accountId, enabled: true });
  });

  app.post('/api/accounts/:accountId/disable', (req, res) => {
    const accountId = Number(req.params['accountId']);
    if (!isKnownAccount(accountId)) {
      res.status(400).json({ error: 'Unknown account' }); return;
    }
    // awaited — returns only after open positions are closed
    engine.setSlaveEnabled(accountId, false)
      .then(() => { cacheExpiry = 0; res.json({ accountId, enabled: false }); })
      .catch(err => res.status(500).json({ error: (err as Error).message }));
  });

  // ── Flatten one account ────────────────────────────────────────────────────

  app.post('/api/flatten/:accountId', (req, res) => {
    const accountId = Number(req.params['accountId']);
    if (!isKnownAccount(accountId)) {
      res.status(400).json({ error: 'Unknown account' }); return;
    }
    flattenAccount(accountId)
      .then(result => { cacheExpiry = 0; res.json(result); })
      .catch(err => res.status(500).json({ error: (err as Error).message }));
  });

  // ── Flatten all accounts ───────────────────────────────────────────────────

  app.post('/api/flatten-all', (_req, res) => {
    Promise.all(engine.getAllAccountIds().map(flattenAccount))
      .then(results => {
        cacheExpiry = 0;
        res.json({ closed: results.reduce((sum, r) => sum + r.closed, 0) });
      })
      .catch(err => res.status(500).json({ error: (err as Error).message }));
  });

  app.listen(port, () => {
    console.log(`[Dashboard] Running at http://localhost:${port}`);
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function flattenAccount(accountId: AccountId): Promise<{ closed: number }> {
  const positions = await getPositions(accountId);
  const open = positions.filter(p => p.netPos !== 0);
  if (open.length === 0) return { closed: 0 };

  await Promise.all(open.map(p =>
    placeMarketOrder({
      accountId,
      symbol:   p.contractId,
      action:   p.netPos > 0 ? 'Sell' : 'Buy',
      orderQty: Math.abs(p.netPos),
    }),
  ));

  console.log(`[Dashboard] Flattened ${open.length} position(s) on account ${accountId}`);
  return { closed: open.length };
}
