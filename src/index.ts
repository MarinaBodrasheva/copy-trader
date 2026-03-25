import { authenticate } from './api/tradovate.js';
import { TradovateSocket } from './ws/TradovateSocket.js';
import { CopyEngine } from './services/CopyEngine.js';
import { PositionTracker } from './services/PositionTracker.js';
import { DailyLossGuard } from './services/DailyLossGuard.js';
import { startDashboard } from './web/server.js';
import { config } from './config/index.js';

async function main(): Promise<void> {
  console.log(`[CopyTrader] Starting in ${config.env.toUpperCase()} mode`);
  console.log(`[CopyTrader] Master account: ${config.masterAccountId}`);
  console.log(`[CopyTrader] Slave accounts: ${config.slaveAccountIds.join(', ')}`);

  if (!config.masterAccountId) {
    throw new Error('MASTER_ACCOUNT_ID is not set in .env');
  }
  if (config.slaveAccountIds.length === 0) {
    throw new Error('SLAVE_ACCOUNT_IDS is not set in .env');
  }

  await authenticate();

  const positionTracker = new PositionTracker();
  await positionTracker.initialize();

  let dailyLossGuard: DailyLossGuard | undefined;
  if (config.maxDailyLossUsd > 0) {
    console.log(`[CopyTrader] Daily loss guard enabled — limit: $${config.maxDailyLossUsd} per slave`);
    dailyLossGuard = new DailyLossGuard(config.slaveAccountIds, config.maxDailyLossUsd);
    await dailyLossGuard.initialize();
  }

  startDashboard(config.webPort, dailyLossGuard);

  const copyEngine = new CopyEngine(positionTracker, dailyLossGuard);
  const socket     = new TradovateSocket(fill => copyEngine.onFill(fill));

  await socket.connect();

  console.log('[CopyTrader] Running — waiting for master fills...');
}

main().catch(err => {
  console.error('[CopyTrader] Fatal error:', (err as Error).message);
  process.exit(1);
});
