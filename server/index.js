import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ibkr from './ibkr.js';
import { initDb, getBars, putBar, isDbAvailable } from './db.js';
import { runMarkovAnalysis } from './analysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(join(__dirname, '../client')));

// widgetId → { symbol, exchange, timeframe } — used to cache bars by key
const activeSubs = new Map();

ibkr.onStatus = (status) => broadcast({ type: 'status', ...status });

ibkr.onBar = (msg) => {
  broadcast(msg);
  const sub = activeSubs.get(msg.widgetId);
  if (sub) {
    putBar(sub.symbol, sub.exchange, sub.timeframe, msg.bar).catch(() => {});
  }
};

ibkr.onHistoricalEnd = (widgetId) => broadcast({ type: 'historicalDataEnd', widgetId });
ibkr.onError = (message) => broadcast({ type: 'error', message });
ibkr.onSearchResults = (results) => broadcast({ type: 'searchResults', results });
ibkr.onScanResult = (result) => broadcast({ type: 'scanResult', result });
ibkr.onScanComplete = () => broadcast({ type: 'scanComplete' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', connected: ibkr.connected, mode: ibkr.mode }));
  if (!isDbAvailable()) {
    ws.send(JSON.stringify({ type: 'error', message: 'DynamoDB not running — bar caching disabled' }));
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'connect') {
      try {
        await ibkr.connect(msg.mode ?? 'paper');
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }

    if (msg.type === 'disconnect') {
      ibkr.disconnect();
    }

    if (msg.type === 'subscribe') {
      const { widgetId } = msg;
      const symbol   = msg.symbol;
      const exchange = msg.exchange  ?? 'SMART';
      const currency = msg.currency  ?? 'USD';
      const timeframe = msg.timeframe ?? '5 mins';

      activeSubs.set(widgetId, { symbol, exchange, timeframe });

      // Serve cache immediately to this client only
      try {
        const cached = await getBars(symbol, exchange, timeframe);
        if (cached.length > 0) {
          cached.forEach(bar =>
            ws.send(JSON.stringify({ type: 'historicalBar', widgetId, bar })));
          ws.send(JSON.stringify({ type: 'historicalDataEnd', widgetId }));
        }
      } catch (err) {
        console.error('Cache read error:', err.message);
      }

      ibkr.subscribe(symbol, exchange, currency, timeframe, widgetId);

      // Fire-and-forget Markov analysis; sends results back via this ws
      const notify = (type, data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
      };
      runMarkovAnalysis(symbol, exchange, currency, widgetId, notify).catch(() => {});
    }

    if (msg.type === 'unsubscribe') {
      activeSubs.delete(msg.widgetId);
      ibkr.unsubscribe(msg.widgetId);
    }

    if (msg.type === 'search') {
      ibkr.search(msg.pattern);
    }

    if (msg.type === 'scanMarket') {
      broadcast({ type: 'scanStart' });
      ibkr.scan(msg.location ?? 'STK.SFB', msg.scanCode ?? 'TOP_VOLUME');
    }
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await initDb();
  console.log(`CandleChart running → http://localhost:${PORT}`);
});
