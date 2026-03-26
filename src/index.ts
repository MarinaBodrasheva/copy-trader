import { authenticate, getAccountList } from './api/tradovate.js';
import { TradovateSocket } from './ws/TradovateSocket.js';
import { CopyEngine } from './services/CopyEngine.js';
import { PositionTracker } from './services/PositionTracker.js';
import { DailyLossGuard } from './services/DailyLossGuard.js';
import { startDashboard, applyWsCashBalance, setConnectionStatus } from './web/server.js';
import { config } from './config/index.js';

const RETRY_DELAY_MS = 10_000;

async function main(): Promise<void> {
  console.log(`[CopyTrader] Starting in ${config.env.toUpperCase()} mode`);
  console.log(`[CopyTrader] Master account: ${config.masterAccountId}`);
  console.log(`[CopyTrader] Slave accounts: ${config.slaveAccountIds.join(', ')}`);

  // These are fatal — no point retrying with broken config
  if (!config.masterAccountId) throw new Error('MASTER_ACCOUNT_ID is not set in .env');
  if (config.slaveAccountIds.length === 0) throw new Error('SLAVE_ACCOUNT_IDS is not set in .env');

  // Create objects — no API calls yet
  const positionTracker = new PositionTracker();

  let dailyLossGuard: DailyLossGuard | undefined;
  if (config.maxDailyLossUsd > 0 || config.maxTotalDailyLossUsd > 0) {
    dailyLossGuard = new DailyLossGuard(
      config.slaveAccountIds,
      config.maxDailyLossUsd,
      config.maxTotalDailyLossUsd,
    );
  }

  const copyEngine = new CopyEngine(positionTracker, dailyLossGuard);

  // All slaves start disabled — user enables them explicitly in the dashboard
  copyEngine.disableAllSlaves();

  // Dashboard is available immediately — shows "connecting" banner
  startDashboard(config.webPort, copyEngine, dailyLossGuard);
  console.log(`[CopyTrader] Dashboard running at http://localhost:${config.webPort}`);

  // Connect to Tradovate in the background — retries forever on failure
  void connectWithRetry(positionTracker, dailyLossGuard, copyEngine);
}

async function connectWithRetry(
  positionTracker: PositionTracker,
  dailyLossGuard: DailyLossGuard | undefined,
  copyEngine: CopyEngine,
): Promise<void> {
  let attempt = 0;
  let accountsInitialized = false;

  while (true) {
    attempt++;
    try {
      setConnectionStatus('connecting', attempt === 1
        ? 'Connecting to Tradovate…'
        : `Reconnecting to Tradovate (attempt ${attempt})…`,
      );

      await authenticate();

      // Fetch account list from API — first account becomes master on first connect
      try {
        const apiAccounts = await getAccountList();
        if (apiAccounts.length > 0) {
          const ids = apiAccounts.map(a => a.id);
          if (!accountsInitialized) {
            copyEngine.setMaster(ids[0]);
            accountsInitialized = true;
          }
          copyEngine.setAccountIds(ids);
          console.log(`[CopyTrader] Loaded ${ids.length} account(s) from API`);
        }
      } catch (err) {
        console.warn('[CopyTrader] Could not load account list from API — using config accounts:',
          err instanceof Error ? err.message : String(err));
      }

      await positionTracker.initialize();
      if (dailyLossGuard) {
        console.log(
          `[CopyTrader] Daily loss guard enabled` +
          (config.maxDailyLossUsd      > 0 ? ` — realized limit: $${config.maxDailyLossUsd}` : '') +
          (config.maxTotalDailyLossUsd > 0 ? ` — total limit: $${config.maxTotalDailyLossUsd}` : ''),
        );
        await dailyLossGuard.initialize();
      }

      const socket = new TradovateSocket(
        fill   => copyEngine.onFill(fill),
        update => {
          applyWsCashBalance(update);
          dailyLossGuard?.applyUpdate(update);
        },
        (connected) => setConnectionStatus(
          connected ? 'connected'     : 'disconnected',
          connected ? 'Connected to Tradovate' : 'Lost connection to Tradovate — reconnecting…',
        ),
      );

      await socket.connect();
      setConnectionStatus('connected', 'Connected to Tradovate');
      console.log('[CopyTrader] Running — waiting for master fills…');
      return; // socket manages its own reconnection from here

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConnectionStatus('disconnected', `Cannot connect to Tradovate: ${msg}`);
      console.error(`[CopyTrader] Connection failed: ${msg}. Retrying in ${RETRY_DELAY_MS / 1000}s…`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  // Only truly fatal errors (bad config) reach here
  console.error('[CopyTrader] Fatal error:', (err as Error).message);
  process.exit(1);
});
