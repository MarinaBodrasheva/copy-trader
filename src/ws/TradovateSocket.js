import WebSocket from 'ws';
import { config } from '../config/index.js';
import { getToken } from '../api/tradovate.js';

const HEARTBEAT_INTERVAL = 2500; // ms — Tradovate requires heartbeat every 2.5s

export class TradovateSocket {
  constructor(onFill) {
    this.ws = null;
    this.msgId = 1;
    this.onFill = onFill; // callback(fillEvent)
    this.heartbeatTimer = null;
    this.reconnectDelay = 3000;
  }

  async connect() {
    const token = await getToken();
    this.ws = new WebSocket(config.wsUrl);

    this.ws.on('open', () => {
      console.log('[WS] Connected to Tradovate');
      this._sendAuth(token);
    });

    this.ws.on('message', (data) => this._handleMessage(data.toString()));

    this.ws.on('close', (code) => {
      console.warn(`[WS] Disconnected (${code}), reconnecting in ${this.reconnectDelay}ms...`);
      this._stopHeartbeat();
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  }

  _sendAuth(token) {
    this._send('authorize', { token });
  }

  _send(endpoint, body = {}) {
    const id = this.msgId++;
    const frame = `${endpoint}\n${id}\n\n${JSON.stringify(body)}`;
    this.ws.send(frame);
    return id;
  }

  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('[]'); // heartbeat frame
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _handleMessage(raw) {
    // Tradovate WS sends 'o' on open, 'h' heartbeat, 'c' close, 'a[...]' data
    if (raw === 'o') {
      console.log('[WS] Socket open frame received');
      return;
    }
    if (raw === 'h') return; // heartbeat ack
    if (raw.startsWith('c')) return; // close frame

    if (raw.startsWith('a')) {
      try {
        const messages = JSON.parse(raw.slice(1)); // strip leading 'a'
        for (const msg of messages) {
          this._processMessage(JSON.parse(msg));
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err.message, raw);
      }
    }
  }

  _processMessage(msg) {
    // After auth, subscribe to user sync
    if (msg.e === 'authorized') {
      console.log('[WS] Authorized on WebSocket');
      this._startHeartbeat();
      this._subscribeUserSync();
      return;
    }

    // Real-time entity updates
    if (msg.e === 'props') {
      const { entityType, entity } = msg.d;

      // We care about fills (executionReport with fillQty)
      if (entityType === 'executionReport' && entity.execType === 'Fill') {
        this.onFill(entity);
      }
    }
  }

  _subscribeUserSync() {
    // user/syncrequest gives us real-time updates for orders, fills, positions
    this._send('user/syncrequest', {
      users: [0], // 0 = current user
    });
    console.log('[WS] Subscribed to user/syncrequest');
  }
}
