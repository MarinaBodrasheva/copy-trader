import fs from 'fs';
import path from 'path';

const LOG_DIR = 'logs';
const LOG_FILE = path.join(LOG_DIR, 'failures.jsonl');

// Ensure logs/ directory exists (sync, runs once at startup)
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Appends a failed copy event to logs/failures.jsonl.
 * Each line is a self-contained JSON object (JSON Lines format).
 */
export function logFailure({ slaveAccountId, contractId, action, qty, orderId, error }) {
  const entry = {
    timestamp: new Date().toISOString(),
    slaveAccountId,
    contractId,
    action,
    qty,
    orderId,
    error,
  };

  const line = JSON.stringify(entry) + '\n';

  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) {
      console.error('[FailureLogger] Could not write to log file:', err.message);
    }
  });
}
