import WebSocket from 'ws';
import { config } from '../config/index.js';
import { getToken } from '../api/tradovate.js';
import type { CashBalanceUpdate, Fill } from '../types.js';

const HEARTBEAT_INTERVAL = 2500; // ms — Tradovate requires heartbeat every 2.5 s

type FillCallback          = (fill: Fill) => void;
type CashBalanceCallback   = (update: CashBalanceUpdate) => void;
type StatusChangeCallback  = (connected: boolean) => void;

interface WsMessage {
  e?: string;
  d?: {
    entityType?: string;
    entity?:     Record<string, unknown>;
  };
}

export class TradovateSocket {
  private ws:              WebSocket | null = null;
  private msgId:           number = 1;
  private heartbeatTimer:  ReturnType<typeof setInterval> | null = null;
  private readonly reconnectDelay = 3000;

  constructor(
    private readonly onFill:          FillCallback,
    private readonly onCashBalance?:  CashBalanceCallback,
    private readonly onStatusChange?: StatusChangeCallback,
  ) {}

  async connect(): Promise<void> {
    const token = await getToken();
    this.ws = new WebSocket(config.wsUrl);

    this.ws.on('open', () => {
      console.log('[WS] Connected to Tradovate');
      this._sendAuth(token);
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this._handleMessage(data.toString());
    });

    this.ws.on('close', (code: number) => {
      console.warn(`[WS] Disconnected (${code}), reconnecting in ${this.reconnectDelay}ms...`);
      this._stopHeartbeat();
      this.onStatusChange?.(false);
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.ws.on('error', (err: Error) => {
      console.error('[WS] Error:', err.message);
    });
  }

  private _sendAuth(token: string): void {
    this._send('authorize', { token });
  }

  private _send(endpoint: string, body: Record<string, unknown> = {}): number {
    const id = this.msgId++;
    const frame = `${endpoint}\n${id}\n\n${JSON.stringify(body)}`;
    this.ws?.send(frame);
    return id;
  }

  private _startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('[]');
      }
    }, HEARTBEAT_INTERVAL);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _handleMessage(raw: string): void {
    if (raw === 'o') { console.log('[WS] Socket open frame received'); return; }
    if (raw === 'h') return; // heartbeat ack
    if (raw.startsWith('c')) return; // close frame

    if (raw.startsWith('a')) {
      try {
        const messages: string[] = JSON.parse(raw.slice(1));
        for (const msg of messages) {
          this._processMessage(JSON.parse(msg) as WsMessage);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[WS] Failed to parse message:', message, raw);
      }
    }
  }

  private _processMessage(msg: WsMessage): void {
    if (msg.e === 'authorized') {
      console.log('[WS] Authorized on WebSocket');
      this._startHeartbeat();
      this._subscribeUserSync();
      this.onStatusChange?.(true);
      return;
    }

    if (msg.e === 'props' && msg.d) {
      const { entityType, entity } = msg.d;
      if (entityType === 'executionReport' && entity?.['execType'] === 'Fill') {
        this.onFill(entity as unknown as Fill);
      }
      if (entityType === 'cashBalance' && entity?.['accountId'] !== undefined) {
        this.onCashBalance?.(entity as unknown as CashBalanceUpdate);
      }
    }
  }

  private _subscribeUserSync(): void {
    this._send('user/syncrequest', { users: [0] });
    console.log('[WS] Subscribed to user/syncrequest');
  }
}
