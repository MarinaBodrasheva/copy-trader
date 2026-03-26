// ── Domain primitives ──────────────────────────────────────────────────────

export type AccountId  = number;
export type ContractId = string; // contract name / symbol used as a stable key
export type Action     = 'Buy' | 'Sell';

// ── Tradovate WebSocket fill event ─────────────────────────────────────────

export interface Fill {
  orderId:    number;
  accountId:  AccountId;
  contractId: ContractId;
  action:     Action;
  qty:        number;
  execType?:  string;
}

// ── Tradovate REST position ────────────────────────────────────────────────

export interface Position {
  contractId: ContractId;
  accountId:  AccountId;
  netPos:     number;
}

// ── Order placement ────────────────────────────────────────────────────────

export interface PlaceOrderParams {
  accountId:  AccountId;
  symbol:     ContractId;
  action:     Action;
  orderQty:   number;
}

export interface PlaceOrderResponse {
  orderId?: string | number;
  [key: string]: unknown;
}

// ── Failure log entry ──────────────────────────────────────────────────────

export interface FailureLogEntry {
  slaveAccountId: AccountId;
  contractId:     ContractId;
  action:         Action;
  qty:            number;
  orderId:        number | string;
  error:          string;
}

// ── Tradovate account info ─────────────────────────────────────────────────

export interface AccountInfo {
  id:   AccountId;
  name: string;
}

// ── Tradovate cash balance snapshot (REST) ─────────────────────────────────

export interface CashBalance {
  accountId:   AccountId;
  amount:      number;   // current cash balance
  realizedPnl: number;   // today's realized P&L
  openPnL?:    number;   // unrealized P&L (if provided by REST response)
}

// ── Tradovate cash balance update (WebSocket push) ─────────────────────────

export interface CashBalanceUpdate {
  accountId:    AccountId;
  amount?:      number;
  realizedPnl?: number;
  openPnL?:     number;
}

// ── Dashboard account summary ──────────────────────────────────────────────

export interface AccountSummary {
  accountId:   AccountId;
  name:        string;
  role:        'master' | 'slave';
  balance:     number;
  realizedPnl: number;
  openPnL:     number | null;
  isLocked:    boolean;
  enabled:     boolean; // slaves only — controlled via dashboard toggle
}

// ── PositionTracker interface (for dependency injection / mocking) ──────────

export interface IPositionTracker {
  initialize():                                                         Promise<void>;
  getNetQty(accountId: AccountId, contractId: ContractId):             number;
  isClosingFill(accountId: AccountId, contractId: ContractId, action: Action): boolean;
  applyFill(accountId: AccountId, contractId: ContractId, action: Action, qty: number): void;
  refreshAccount(accountId: AccountId):                                 Promise<void>;
  reconcile():                                                          Promise<void>;
}
