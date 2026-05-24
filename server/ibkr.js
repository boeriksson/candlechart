import { IBApi, EventName, SecType, ScanCode } from '@stoqey/ib';

const PORTS = { paper: 4002, live: 4001 };

class IBKRConnection {
  constructor() {
    this.ib = null;
    this.connected = false;
    this.mode = 'paper';
    this.reqIdCounter = 1;
    this.activeReqs = new Map();       // reqId → { widgetId }
    this.histEndFired = new Map();     // reqId → boolean
    this.pendingCallbacks = new Map(); // reqId → { bars[], resolve, reject }

    this.onStatus = null;
    this.onBar = null;
    this.onHistoricalEnd = null;
    this.onError = null;
    this.onSearchResults = null;
    this.searchReqId = null;
    this.onScanResult = null;
    this.onScanComplete = null;
    this.scannerReqId = null;
    this._scanBuffer = [];
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
        const msg = err?.message ?? String(err);
        if (code === 162 && msg.includes('cancelled')) return;
        this.onError?.(`${msg} (code: ${code})`);
      });

      this.ib.on(EventName.historicalData, (reqId, timeStr, open, high, low, close, volume) => {
        const entry = this.activeReqs.get(reqId);
        if (entry) {
          if (String(timeStr).startsWith('finished')) {
            this._fireHistEnd(reqId);
          } else {
            const time = parseIBTime(timeStr);
            if (!isNaN(time)) {
              this.onBar?.({ type: 'historicalBar', widgetId: entry.widgetId, bar: {
                time, open, high, low, close,
                volume: volume > 0 ? volume : 0,
              }});
            }
          }
          return;
        }

        const pending = this.pendingCallbacks.get(reqId);
        if (pending) {
          if (String(timeStr).startsWith('finished')) {
            this.pendingCallbacks.delete(reqId);
            pending.resolve(pending.bars);
          } else {
            const time = parseIBTime(timeStr);
            if (!isNaN(time)) pending.bars.push({ time, open, high, low, close, volume: volume > 0 ? volume : 0 });
          }
        }
      });

      this.ib.on(EventName.historicalDataEnd, (reqId) => {
        if (this.activeReqs.has(reqId)) {
          this._fireHistEnd(reqId);
          return;
        }
        const pending = this.pendingCallbacks.get(reqId);
        if (pending) {
          this.pendingCallbacks.delete(reqId);
          pending.resolve(pending.bars);
        }
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

      this.ib.on(EventName.scannerData, (reqId, rank, contractDetails) => {
        if (reqId !== this.scannerReqId) return;
        const c = contractDetails?.contract;
        if (!c) return;
        this._scanBuffer.push({
          rank,
          symbol: c.symbol,
          exchange: 'SMART',
          currency: c.currency,
          name: contractDetails.marketName || '',
        });
      });

      this.ib.on(EventName.scannerDataEnd, (reqId) => {
        if (reqId !== this.scannerReqId) return;
        try { this.ib.cancelScannerSubscription(reqId); } catch {}
        this.scannerReqId = null;
        const results = [...this._scanBuffer];
        this._scanBuffer = [];
        this._fetchScannerPrices(results).catch(() => { this.onScanComplete?.(); });
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

  scan(location, scanCode) {
    if (!this.connected) { this.onError?.('Not connected'); return; }
    if (this.scannerReqId !== null) {
      try { this.ib.cancelScannerSubscription(this.scannerReqId); } catch {}
    }
    this._scanBuffer = [];
    const reqId = this.reqIdCounter++;
    this.scannerReqId = reqId;
    this.ib.reqScannerSubscription(reqId, {
      numberOfRows: 20,
      instrument: 'STK',
      locationCode: location,
      scanCode: ScanCode[scanCode],  // encoder reverse-maps numeric → string for wire
      stockTypeFilter: 'ALL',
    }, []);
  }

  _fetchContractName(symbol, currency) {
    return new Promise((resolve) => {
      const reqId = this.reqIdCounter++;
      let name = '';
      const onDetails = (id, details) => {
        if (id !== reqId) return;
        name = details.longName || '';
      };
      const onEnd = (id) => {
        if (id !== reqId) return;
        this.ib.removeListener(EventName.contractDetails, onDetails);
        this.ib.removeListener(EventName.contractDetailsEnd, onEnd);
        resolve(name);
      };
      this.ib.on(EventName.contractDetails, onDetails);
      this.ib.on(EventName.contractDetailsEnd, onEnd);
      this.ib.reqContractDetails(reqId, { symbol, secType: SecType.STK, exchange: 'SMART', currency });
      setTimeout(() => {
        this.ib.removeListener(EventName.contractDetails, onDetails);
        this.ib.removeListener(EventName.contractDetailsEnd, onEnd);
        resolve(name);
      }, 4000);
    });
  }

  async _fetchScannerPrices(results) {
    for (const r of results) {
      r.name = await this._fetchContractName(r.symbol, r.currency);
      try {
        const bars = await this.fetchHistorical(r.symbol, r.exchange, r.currency, '5 D', '1 day');
        if (bars.length >= 2) {
          r.price = bars[bars.length - 1].close;
          r.change = (bars[bars.length - 1].close - bars[bars.length - 2].close) / bars[bars.length - 2].close * 100;
        } else if (bars.length === 1) {
          r.price = bars[0].close;
          r.change = 0;
        }
      } catch {}
      this.onScanResult?.(r);
      await new Promise(res => setTimeout(res, 200));
    }
    this.onScanComplete?.();
  }

  fetchHistorical(symbol, exchange, currency, duration = '20 Y', timeframe = '1 day') {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      const reqId = this.reqIdCounter++;
      this.pendingCallbacks.set(reqId, { bars: [], resolve, reject });
      const contract = { symbol, secType: SecType.STK, exchange, currency };
      this.ib.reqHistoricalData(reqId, contract, '', duration, timeframe, 'TRADES', 0, 1, false, []);
      setTimeout(() => {
        if (this.pendingCallbacks.has(reqId)) {
          this.pendingCallbacks.delete(reqId);
          reject(new Error('Historical fetch timeout'));
        }
      }, 120000);
    });
  }

  _cancelAll() {
    for (const [reqId] of this.activeReqs) {
      try { this.ib.cancelHistoricalData(reqId); } catch {}
    }
    this.activeReqs.clear();
    this.histEndFired.clear();
    for (const [, pending] of this.pendingCallbacks) {
      pending.reject(new Error('Disconnected'));
    }
    this.pendingCallbacks.clear();
    if (this.scannerReqId !== null) {
      try { this.ib.cancelScannerSubscription(this.scannerReqId); } catch {}
      this.scannerReqId = null;
    }
    this._scanBuffer = [];
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

  // Plain digits: either YYYYMMDD (daily bars) or Unix timestamp
  if (/^\d+$/.test(str)) {
    if (str.length === 8) {
      // YYYYMMDD — convert to UTC midnight Unix seconds
      return Math.floor(new Date(`${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}T00:00:00Z`).getTime() / 1000);
    }
    return parseInt(str, 10);
  }

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
