import { authenticate } from './api/tradovate.js';
import { TradovateSocket } from './ws/TradovateSocket.js';
import { CopyEngine } from './services/CopyEngine.js';
import { PositionTracker } from './services/PositionTracker.js';
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

  const copyEngine = new CopyEngine(positionTracker);
  const socket     = new TradovateSocket(fill => copyEngine.onFill(fill));

  await socket.connect();

  console.log('[CopyTrader] Running — waiting for master fills...');
}

main().catch(err => {
  console.error('[CopyTrader] Fatal error:', (err as Error).message);
  process.exit(1);
});
