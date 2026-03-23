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

// ── PositionTracker interface (for dependency injection / mocking) ──────────

export interface IPositionTracker {
  initialize():                                                         Promise<void>;
  getNetQty(accountId: AccountId, contractId: ContractId):             number;
  isClosingFill(accountId: AccountId, contractId: ContractId, action: Action): boolean;
  applyFill(accountId: AccountId, contractId: ContractId, action: Action, qty: number): void;
  refreshAccount(accountId: AccountId):                                 Promise<void>;
  reconcile():                                                          Promise<void>;
}
