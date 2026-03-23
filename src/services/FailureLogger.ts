import fs from 'fs';
import path from 'path';
import type { FailureLogEntry } from '../types.js';

const LOG_DIR  = 'logs';
const LOG_FILE = path.join(LOG_DIR, 'failures.jsonl');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

interface StoredEntry extends FailureLogEntry {
  timestamp: string;
}

export function logFailure(entry: FailureLogEntry): void {
  const stored: StoredEntry = { ...entry, timestamp: new Date().toISOString() };
  const line = JSON.stringify(stored) + '\n';

  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error('[FailureLogger] Could not write to log file:', err.message);
  });
}
