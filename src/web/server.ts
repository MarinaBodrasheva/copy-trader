import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAccountList, getCashBalance, getPositions, placeMarketOrder } from '../api/tradovate.js';
import { config } from '../config/index.js';
import type { DailyLossGuard } from '../services/DailyLossGuard.js';
import type { AccountSummary } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache results for 5 s to avoid hammering the API on every page load
const CACHE_TTL_MS = 5_000;
let cachedSummaries: AccountSummary[] = [];
let cacheExpiry = 0;

async function buildSummaries(guard?: DailyLossGuard): Promise<AccountSummary[]> {
  if (Date.now() < cacheExpiry) return cachedSummaries;

  const allAccountIds = [config.masterAccountId, ...config.slaveAccountIds];

  const [accounts, ...balances] = await Promise.all([
    getAccountList(),
    ...allAccountIds.map(id => getCashBalance(id).catch(() => null)),
  ]);

  const nameMap = new Map(accounts.map(a => [a.id, a.name]));

  cachedSummaries = allAccountIds.map((accountId, i) => {
    const bal = balances[i];
    return {
      accountId,
      name:        nameMap.get(accountId) ?? String(accountId),
      role:        accountId === config.masterAccountId ? 'master' : 'slave',
      balance:     bal?.amount      ?? 0,
      realizedPnl: bal?.realizedPnl ?? 0,
      openPnL:     bal?.openPnL     ?? null,
      isLocked:    guard?.isLocked(accountId) ?? false,
    };
  });

  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cachedSummaries;
}

export function startDashboard(port: number, guard?: DailyLossGuard): void {
  const app = express();

  // Serve the public folder (index.html) from project root
  const publicDir = path.resolve(__dirname, '../../public');
  app.use(express.static(publicDir));

  app.get('/api/accounts', (_req, res) => {
    buildSummaries(guard)
      .then(data => res.json(data))
      .catch(err => {
        console.error('[Dashboard] /api/accounts error:', (err as Error).message);
        res.status(500).json({ error: 'Failed to fetch account data' });
      });
  });

  const allAccountIds = new Set([config.masterAccountId, ...config.slaveAccountIds]);

  app.post('/api/flatten/:accountId', (req, res) => {
    const accountId = Number(req.params['accountId']);
    if (!allAccountIds.has(accountId)) {
      res.status(400).json({ error: 'Unknown account' });
      return;
    }

    console.log(`[Dashboard] Flatten requested for account ${accountId}`);

    getPositions(accountId)
      .then(async positions => {
        const open = positions.filter(p => p.netPos !== 0);
        if (open.length === 0) {
          return { closed: 0 };
        }

        await Promise.all(open.map(p =>
          placeMarketOrder({
            accountId,
            symbol:   p.contractId,
            action:   p.netPos > 0 ? 'Sell' : 'Buy',
            orderQty: Math.abs(p.netPos),
          }),
        ));

        // Expire cache so next poll shows fresh data
        cacheExpiry = 0;

        console.log(`[Dashboard] Flattened ${open.length} position(s) on account ${accountId}`);
        return { closed: open.length };
      })
      .then(result => res.json(result))
      .catch(err => {
        console.error(`[Dashboard] Flatten error for ${accountId}:`, (err as Error).message);
        res.status(500).json({ error: (err as Error).message });
      });
  });

  app.listen(port, () => {
    console.log(`[Dashboard] Running at http://localhost:${port}`);
  });
}
