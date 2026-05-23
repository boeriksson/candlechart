import { IBApi, EventName, SecType } from '@stoqey/ib';

const PORTS = { paper: 4002, live: 4001 };

class IBKRConnection {
  constructor() {
    this.ib = null;
    this.connected = false;
    this.mode = 'paper';
    this.reqIdCounter = 1;
    this.activeReqs = new Map();    // reqId → { widgetId }
    this.histEndFired = new Map();  // reqId → boolean

    this.onStatus = null;
    this.onBar = null;
    this.onHistoricalEnd = null;
    this.onError = null;
    this.onSearchResults = null;
    this.searchReqId = null;
  }

  connect(mode = 'paper') {
    return new Promise((resolve, reject) => {
      if (this.ib) {
        this._cancelAll();
        this.ib.disconnect();
        this.ib = null;
        this.connected = false;
      }

      this.mode = mode;
      const port = parseInt(process.env[`GATEWAY_PORT_${mode.toUpperCase()}`] || PORTS[mode]);
      const host = process.env.GATEWAY_HOST || '127.0.0.1';

      this.ib = new IBApi({ host, port, clientId: 1 });

      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout — check Gateway is running on ${host}:${port}`));
      }, 8000);

      this.ib.on(EventName.connected, () => {
        clearTimeout(timeout);
        this.connected = true;
        this.onStatus?.({ connected: true, mode: this.mode });
        resolve();
      });

      this.ib.on(EventName.disconnected, () => {
        this.connected = false;
        this.onStatus?.({ connected: false, mode: this.mode });
      });

      this.ib.on(EventName.error, (err, code) => {
        if ([2104, 2106, 2158, 2119].includes(code)) return;
        this.onError?.(`${err?.message ?? err} (code: ${code})`);
      });

      this.ib.on(EventName.historicalData, (reqId, timeStr, open, high, low, close, volume) => {
        const entry = this.activeReqs.get(reqId);
        if (!entry) return;

        if (String(timeStr).startsWith('finished')) {
          this._fireHistEnd(reqId);
          return;
        }

        const time = parseIBTime(timeStr);
        if (isNaN(time)) return;

        this.onBar?.({ type: 'historicalBar', widgetId: entry.widgetId, bar: {
          time, open, high, low, close,
          volume: volume > 0 ? volume : 0,
        }});
      });

      this.ib.on(EventName.historicalDataEnd, (reqId) => {
        if (!this.activeReqs.has(reqId)) return;
        this._fireHistEnd(reqId);
      });

      this.ib.on(EventName.symbolSamples, (reqId, contractDescriptions) => {
        if (reqId !== this.searchReqId) return;
        const descriptions = Array.isArray(contractDescriptions) ? contractDescriptions : [contractDescriptions];
        const results = descriptions
          .filter(cd => cd?.contract?.secType === 'STK')
          .slice(0, 10)
          .map(cd => ({
            symbol: cd.contract.symbol,
            name: cd.contract.description || '',
            exchange: cd.contract.primaryExch || 'SMART',
            currency: cd.contract.currency,
          }));
        this.onSearchResults?.(results);
      });

      this.ib.on(EventName.historicalDataUpdate, (reqId, timeStr, open, high, low, close, volume) => {
        const entry = this.activeReqs.get(reqId);
        if (!entry) return;
        const time = parseIBTime(timeStr);
        if (isNaN(time)) return;
        this.onBar?.({ type: 'realtimeBar', widgetId: entry.widgetId, bar: {
          time, open, high, low, close,
          volume: volume > 0 ? volume : 0,
        }});
      });

      this.ib.connect();
    });
  }

  _fireHistEnd(reqId) {
    if (this.histEndFired.get(reqId)) return;
    this.histEndFired.set(reqId, true);
    const entry = this.activeReqs.get(reqId);
    if (!entry) return;
    this.onHistoricalEnd?.(entry.widgetId);
  }

  subscribe(symbol, exchange = 'SMART', currency = 'USD', timeframe = '5 mins', widgetId) {
    if (!this.connected) {
      this.onError?.('Not connected — connect first');
      return;
    }

    const reqId = this.reqIdCounter++;
    this.activeReqs.set(reqId, { widgetId });
    this.histEndFired.set(reqId, false);

    const contract = { symbol, secType: SecType.STK, exchange, currency };

    this.ib.reqHistoricalData(
      reqId,
      contract,
      '',
      '5 D',
      timeframe,
      'TRADES',
      0,
      1,
      false,
      [],
    );
  }

  unsubscribe(widgetId) {
    for (const [reqId, entry] of this.activeReqs) {
      if (entry.widgetId === widgetId) {
        try { this.ib.cancelHistoricalData(reqId); } catch {}
        this.activeReqs.delete(reqId);
        this.histEndFired.delete(reqId);
        break;
      }
    }
  }

  search(pattern) {
    if (!this.connected || !pattern) return;
    const reqId = this.reqIdCounter++;
    this.searchReqId = reqId;
    this.ib.reqMatchingSymbols(reqId, pattern);
  }

  _cancelAll() {
    for (const [reqId] of this.activeReqs) {
      try { this.ib.cancelHistoricalData(reqId); } catch {}
    }
    this.activeReqs.clear();
    this.histEndFired.clear();
  }

  disconnect() {
    this._cancelAll();
    this.ib?.disconnect();
    this.ib = null;
    this.connected = false;
  }
}

// Convert IB time string "YYYYMMDD HH:MM:SS Timezone" → UTC Unix seconds
function parseIBTime(timeStr) {
  const str = String(timeStr);

  // Plain unix timestamp string
  if (/^\d+$/.test(str)) return parseInt(str, 10);

  const m = str.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(.+)$/);
  if (!m) return NaN;
  const [, y, mo, d, h, min, s, tz] = m;

  // Treat input time as UTC to get a starting point, then compute offset via Intl
  const guess = new Date(`${y}-${mo}-${d}T${h}:${min}:${s}Z`);

  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  // sv-SE gives "YYYY-MM-DD HH:MM:SS" — parse it back as UTC to get offset
  const inTz = fmt.format(guess);
  const inTzMs = new Date(inTz.replace(' ', 'T') + 'Z').getTime();
  const offsetMs = guess.getTime() - inTzMs;

  return Math.floor((guess.getTime() + offsetMs) / 1000);
}

export default new IBKRConnection();
