const ws = new WebSocket(`ws://${location.host}`);

// --- State ---
let connected = false;
let selectedExchange = 'SMART';
let selectedCurrency = 'USD';
let selectedName = '';
let widgetIdCounter = 0;
const widgets = new Map();  // id → WidgetState
let expandedWidgetId = null;
let searchTimer = null;
let searchEnabled = true;

// --- WebSocket ---
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'status':         onStatus(msg); break;
    case 'historicalBar':  onHistoricalBar(msg); break;
    case 'historicalDataEnd': onHistoricalDataEnd(msg); break;
    case 'realtimeBar':    onRealtimeBar(msg); break;
    case 'searchResults':  if (searchEnabled) showDropdown(msg.results); break;
    case 'error':          showToast(msg.message, 'error'); break;
    case 'analysisStatus': onAnalysisStatus(msg); break;
    case 'analysisResult': onAnalysisResult(msg); break;
    case 'enrichedResult': onEnrichedResult(msg); break;
    case 'scanStart':      onScanStart(); break;
    case 'scanResult':     onScanResult(msg.result); break;
    case 'scanComplete':   onScanComplete(); break;
  }
});

ws.addEventListener('close', () => onStatus({ connected: false, mode: null }));

// --- Bar message handlers ---
function onHistoricalBar(msg) {
  const w = widgets.get(msg.widgetId);
  if (!w) return;
  if (w.pendingClear) {
    w.candleSeries.setData([]);
    w.volumeSeries.setData([]);
    w.ma20Series.setData([]);
    w.ma200Series.setData([]);
    w.bars = [];
    w.pendingClear = false;
  }
  w.barCount++;
  addBar(w, msg.bar);
  w.candleSeries.update(msg.bar);
  w.volumeSeries.update({
    time: msg.bar.time,
    value: msg.bar.volume,
    color: msg.bar.close >= msg.bar.open ? '#26a69a55' : '#ef535055',
  });
}

function onHistoricalDataEnd(msg) {
  const w = widgets.get(msg.widgetId);
  if (!w) return;
  updateWidgetMA(msg.widgetId);
  w.pendingScope = null;
  if (DAILY_SCOPES.has(w.scope)) { applyDailyScopeZoom(msg.widgetId); return; }
  if (w.scope === '1w') { const r = getScopeRange('1w'); if (r) w.chart.timeScale().setVisibleRange(r); return; }
  applyTailZoom(msg.widgetId);
}

function onAnalysisStatus(msg) {
  const { widgetId, status, message } = msg;
  const w = widgets.get(widgetId);
  if (!w) return;

  if (status === 'fetching') {
    setWidgetOverlay(widgetId, true, message || '');
    startOverlayProgress(widgetId, 0);
  } else if (status === 'calculating') {
    setWidgetOverlay(widgetId, true, message || '');
    startOverlayProgress(widgetId, 80);
  } else {
    clearInterval(w.overlayTimer);
    w.overlayTimer = null;
    setOverlayPct(widgetId, 100);
    setTimeout(() => setWidgetOverlay(widgetId, false, ''), 800);
  }
}

function startOverlayProgress(id, from) {
  const w = widgets.get(id);
  if (!w) return;
  clearInterval(w.overlayTimer);
  w.overlayProgress = from;
  setOverlayPct(id, Math.round(from));
  w.overlayTimer = setInterval(() => {
    w.overlayProgress = Math.min(95, w.overlayProgress + (95 - w.overlayProgress) * 0.018);
    setOverlayPct(id, Math.round(w.overlayProgress));
  }, 300);
}

function setOverlayPct(id, pct) {
  const el = document.querySelector(`[data-widget-id="${id}"] .overlay-pct`);
  if (el) el.textContent = `${pct}%`;
}

function onAnalysisResult(msg) {
  const w = widgets.get(msg.widgetId);
  if (!w) return;
  w.markovData = msg;
  updateStateBadge(msg.widgetId);
}

function onEnrichedResult(msg) {
  const w = widgets.get(msg.widgetId);
  if (!w) return;
  w.markovData = { ...w.markovData, enriched: msg.enriched };
  updateStateBadge(msg.widgetId);
  // Re-render popup if open
  const popup = document.querySelector(`[data-widget-id="${msg.widgetId}"] .markov-popup`);
  if (popup && !popup.classList.contains('hidden'))
    popup.innerHTML = renderMatrix(w.markovData.transitions, msg.enriched);
}

function updateStateBadge(widgetId) {
  const w = widgets.get(widgetId);
  if (!w?.markovData) return;
  const badge = document.querySelector(`[data-widget-id="${widgetId}"] .widget-state`);
  if (!badge) return;
  const state = w.markovData.currentState;
  const sig = w.markovData.enriched?.signal;
  badge.textContent = state + (sig != null ? ` ${sig > 0 ? '+' : ''}${(sig * 100).toFixed(0)}` : '');
  badge.className = `widget-state state-${state.toLowerCase()}`;
}

function setWidgetOverlay(id, visible, message) {
  const el = document.querySelector(`[data-widget-id="${id}"] .widget-overlay`);
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  el.querySelector('.overlay-msg').textContent = message;
}

function toggleMarkovPopup(id) {
  const w = widgets.get(id);
  if (!w?.markovData) return;
  const popup = document.querySelector(`[data-widget-id="${id}"] .markov-popup`);
  if (!popup) return;
  const opening = popup.classList.contains('hidden');
  popup.classList.toggle('hidden');
  if (opening) popup.innerHTML = renderMatrix(w.markovData.transitions, w.markovData.enriched);
}

function renderMatrix(t, enriched) {
  const states = ['BULL', 'BEAR', 'SIDEWAYS'];
  const rowTotals = states.map(from =>
    states.reduce((sum, to) => sum + (t[`${from}_${to}`] || 0), 0));
  const pct = (from, to) => {
    const total = rowTotals[states.indexOf(from)];
    return total ? ((t[`${from}_${to}`] || 0) / total * 100).toFixed(0) + '%' : '—';
  };
  const color = s => s === 'BULL' ? '#26a69a' : s === 'BEAR' ? '#ef5350' : '#f59e0b';
  const p2 = v => v != null ? (v * 100).toFixed(1) + '%' : '—';

  // Transition matrix
  let html = '<table><thead><tr><th>→</th>';
  states.forEach(s => { html += `<th style="color:${color(s)}">${s}</th>`; });
  html += '</tr></thead><tbody>';
  states.forEach(from => {
    html += `<tr><td style="color:${color(from)}">${from}</td>`;
    states.forEach(to => { html += `<td>${pct(from, to)}</td>`; });
    html += '</tr>';
  });
  html += '</tbody></table>';

  if (!enriched) return html;

  const { signal, nextStateProbabilities: nsp, stationaryDistribution: sd, persistenceDiagonal: pd, walkForward: wf } = enriched;

  // Signal bar
  const sigPct = Math.round((signal + 1) / 2 * 100); // map [-1,1] → [0,100]
  const sigColor = signal > 0.1 ? '#26a69a' : signal < -0.1 ? '#ef5350' : '#f59e0b';
  const sigLabel = signal > 0 ? `+${(signal * 100).toFixed(1)}` : (signal * 100).toFixed(1);
  html += `<div class="mp-section">
    <div class="mp-row"><span class="mp-label">Signal</span>
      <span class="mp-signal-bar"><span class="mp-signal-fill" style="width:${sigPct}%;background:${sigColor}"></span></span>
      <span class="mp-val" style="color:${sigColor}">${sigLabel}</span>
    </div>
  </div>`;

  // Next-state probabilities
  html += `<div class="mp-section">
    <div class="mp-section-title">Next-day probabilities</div>
    <div class="mp-row">
      <span style="color:#26a69a">Bull ${p2(nsp?.bull)}</span>
      <span style="color:#ef5350">Bear ${p2(nsp?.bear)}</span>
      <span style="color:#f59e0b">Side ${p2(nsp?.sideways)}</span>
    </div>
  </div>`;

  // Stationary distribution + persistence
  html += `<div class="mp-section">
    <div class="mp-section-title">Long-run mix</div>
    <div class="mp-row">
      <span style="color:#26a69a">Bull ${p2(sd?.bull)}</span>
      <span style="color:#ef5350">Bear ${p2(sd?.bear)}</span>
      <span style="color:#f59e0b">Side ${p2(sd?.sideways)}</span>
    </div>
    <div class="mp-section-title" style="margin-top:4px">Persistence (stay)</div>
    <div class="mp-row">
      <span style="color:#26a69a">Bull ${p2(pd?.bull)}</span>
      <span style="color:#ef5350">Bear ${p2(pd?.bear)}</span>
      <span style="color:#f59e0b">Side ${p2(pd?.sideways)}</span>
    </div>
  </div>`;

  // Walk-forward
  if (wf) {
    const sharpe = wf.sharpe != null ? wf.sharpe.toFixed(2) : '—';
    const mdd = wf.maxDrawdown != null ? (wf.maxDrawdown * 100).toFixed(1) + '%' : '—';
    const sharpeColor = wf.sharpe > 0.5 ? '#26a69a' : wf.sharpe < 0 ? '#ef5350' : '#b2b5be';
    html += `<div class="mp-section">
      <div class="mp-section-title">Walk-forward backtest</div>
      <div class="mp-row">
        <span class="mp-label">Sharpe</span>
        <span class="mp-val" style="color:${sharpeColor}">${sharpe}</span>
      </div>
      <div class="mp-row">
        <span class="mp-label">Max DD</span>
        <span class="mp-val" style="color:#ef5350">${mdd}</span>
      </div>
      <div class="mp-row">
        <span class="mp-label">Trades</span>
        <span class="mp-val">${wf.nTrades}</span>
      </div>
    </div>`;
  }

  return html;
}

function onRealtimeBar(msg) {
  const w = widgets.get(msg.widgetId);
  if (!w) return;
  addBar(w, msg.bar);
  w.candleSeries.update(msg.bar);
  w.volumeSeries.update({
    time: msg.bar.time,
    value: msg.bar.volume,
    color: msg.bar.close >= msg.bar.open ? '#26a69a55' : '#ef535055',
  });
  appendMAPoint(msg.widgetId);
}

function applyTailZoom(id) {
  const w = widgets.get(id);
  if (!w) return;
  const el = document.querySelector(`[data-widget-id="${id}"] .widget-chart`);
  const barsToShow = Math.max(10, Math.floor((el ? el.clientWidth : 600) / 7));
  const range = w.chart.timeScale().getVisibleLogicalRange();
  if (range) {
    w.chart.timeScale().setVisibleLogicalRange({ from: range.to - barsToShow, to: range.to });
  } else {
    w.chart.timeScale().fitContent();
  }
}

// --- Scope ---
const DAILY_SCOPES = new Set(['1m', 'this year', '1y', '3y']);

function getScopeRange(scope) {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  switch (scope) {
    case '1d':        return { from: now - day,     to: now };
    case '1w':        return { from: now - 7 * day, to: now };
    default:          return null;
  }
}

// For daily-bar scopes, use logical (bar-index) range so bars fill width without weekend gaps
function getScopeBarCount(scope) {
  switch (scope) {
    case '1m':        return 22;
    case 'this year': {
      const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime();
      return Math.max(1, Math.round((Date.now() - jan1) / 86400000 * 5 / 7));
    }
    case '1y':        return 252;
    case '3y':        return 756;
    default:          return null;
  }
}

function applyDailyScopeZoom(id) {
  const w = widgets.get(id);
  if (!w) return;
  const n = getScopeBarCount(w.scope);
  if (n === null || !w.bars.length) return;
  w.chart.timeScale().setVisibleLogicalRange({
    from: w.bars.length - 1 - n,
    to: w.bars.length - 1,
  });
}

function setWidgetScope(id, scope) {
  const w = widgets.get(id);
  if (!w) return;
  const prevScope = w.scope;
  w.scope = scope;

  document.querySelectorAll(`[data-widget-id="${id}"] .scope-btn`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scope === scope);
  });

  const range = getScopeRange(scope);
  const needsDaily = DAILY_SCOPES.has(scope);
  const hadDaily = DAILY_SCOPES.has(prevScope);
  const tfSelect = document.querySelector(`[data-widget-id="${id}"] .widget-timeframe`);

  if (needsDaily && w.timeframe !== '1 day') {
    w.savedTimeframe = w.timeframe;
    tfSelect.value = '1 day';
    w.pendingScope = range;
    resubscribeWidget(id);
  } else if (!needsDaily && hadDaily && w.savedTimeframe) {
    tfSelect.value = w.savedTimeframe;
    w.savedTimeframe = null;
    w.pendingScope = range;
    resubscribeWidget(id);
  } else {
    if (scope === '1d') applyTailZoom(id);
    else if (DAILY_SCOPES.has(scope)) applyDailyScopeZoom(id);
    else if (range) w.chart.timeScale().setVisibleRange(range);
  }
}

// --- Moving averages ---
function addBar(w, bar) {
  const last = w.bars[w.bars.length - 1];
  if (!last || bar.time > last.time) {
    w.bars.push(bar);
    return;
  }
  if (bar.time === last.time) {
    w.bars[w.bars.length - 1] = bar;
    return;
  }
  let i = w.bars.length - 2;
  while (i >= 0 && w.bars[i].time > bar.time) i--;
  if (i >= 0 && w.bars[i].time === bar.time) w.bars[i] = bar;
  else w.bars.splice(i + 1, 0, bar);
}

function calculateMA(bars, period) {
  const result = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) result.push({ time: bars[i].time, value: sum / period });
  }
  return result;
}

function updateWidgetMA(id) {
  const w = widgets.get(id);
  if (!w) return;
  if (w.ma20Enabled) w.ma20Series.setData(calculateMA(w.bars, 20));
  if (w.ma200Enabled) w.ma200Series.setData(calculateMA(w.bars, 200));
}

function appendMAPoint(id) {
  const w = widgets.get(id);
  if (!w || !w.bars.length) return;
  const bars = w.bars;
  const last = bars[bars.length - 1];
  if (w.ma20Enabled && bars.length >= 20) {
    const val = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
    w.ma20Series.update({ time: last.time, value: val });
  }
  if (w.ma200Enabled && bars.length >= 200) {
    const val = bars.slice(-200).reduce((s, b) => s + b.close, 0) / 200;
    w.ma200Series.update({ time: last.time, value: val });
  }
}

// --- Widget factory ---
function createWidget(symbol, exchange, currency, name) {
  const id = ++widgetIdCounter;

  // Build DOM safely (no innerHTML to avoid XSS from symbol/name data)
  const widget = document.createElement('div');
  widget.className = 'widget';
  widget.dataset.widgetId = id;

  const header = document.createElement('div');
  header.className = 'widget-header';

  const title = document.createElement('span');
  title.className = 'widget-title';
  title.textContent = name ? `${name} (${symbol})  ${exchange} · ${currency}` : `${symbol}  ${exchange} · ${currency}`;

  const stateBadge = document.createElement('span');
  stateBadge.className = 'widget-state';
  stateBadge.textContent = '…';
  stateBadge.addEventListener('click', () => toggleMarkovPopup(id));

  const tfSelect = document.createElement('select');
  tfSelect.className = 'widget-timeframe';
  [['1 min','1m'],['5 mins','5m'],['15 mins','15m'],['30 mins','30m'],['1 hour','1h'],['1 day','1D']].forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === '5 mins') opt.selected = true;
    tfSelect.appendChild(opt);
  });

  const ma20Label = document.createElement('label');
  ma20Label.className = 'ma-toggle';
  const ma20Cb = document.createElement('input');
  ma20Cb.type = 'checkbox';
  const ma20Span = document.createElement('span');
  ma20Span.className = 'ma-label ma-20';
  ma20Span.textContent = 'MA20';
  ma20Label.appendChild(ma20Cb);
  ma20Label.appendChild(ma20Span);

  const ma200Label = document.createElement('label');
  ma200Label.className = 'ma-toggle';
  const ma200Cb = document.createElement('input');
  ma200Cb.type = 'checkbox';
  const ma200Span = document.createElement('span');
  ma200Span.className = 'ma-label ma-200';
  ma200Span.textContent = 'MA200';
  ma200Label.appendChild(ma200Cb);
  ma200Label.appendChild(ma200Span);

  const expandBtn = document.createElement('button');
  expandBtn.className = 'widget-expand-btn';
  expandBtn.title = 'Expand';
  expandBtn.textContent = '⤢';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'widget-close-btn';
  closeBtn.title = 'Remove';
  closeBtn.textContent = '×';

  header.appendChild(title);
  header.appendChild(stateBadge);
  header.appendChild(ma20Label);
  header.appendChild(ma200Label);
  header.appendChild(tfSelect);
  header.appendChild(expandBtn);
  header.appendChild(closeBtn);

  const overlay = document.createElement('div');
  overlay.className = 'widget-overlay hidden';
  overlay.innerHTML = '<div class="spinner"></div><span class="overlay-msg"></span><span class="overlay-pct"></span>';

  const markovPopup = document.createElement('div');
  markovPopup.className = 'markov-popup hidden';

  const chartDiv = document.createElement('div');
  chartDiv.className = 'widget-chart';

  const footer = document.createElement('div');
  footer.className = 'widget-footer';
  ['1d', '1w', '1m', 'this year', '1y', '3y'].forEach(scope => {
    const btn = document.createElement('button');
    btn.className = 'scope-btn' + (scope === '1d' ? ' active' : '');
    btn.dataset.scope = scope;
    btn.textContent = scope;
    btn.addEventListener('click', () => setWidgetScope(id, scope));
    footer.appendChild(btn);
  });

  widget.appendChild(header);
  widget.appendChild(overlay);
  widget.appendChild(markovPopup);
  widget.appendChild(chartDiv);
  widget.appendChild(footer);
  document.getElementById('widget-grid').appendChild(widget);

  // Init chart
  const chart = LightweightCharts.createChart(chartDiv, {
    width: chartDiv.clientWidth,
    height: chartDiv.clientHeight,
    layout: {
      background: { color: '#131722' },
      textColor: '#b2b5be',
    },
    grid: {
      vertLines: { color: '#1e2130' },
      horzLines: { color: '#1e2130' },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#2a2e39' },
    timeScale: {
      borderColor: '#2a2e39',
      timeVisible: true,
      secondsVisible: false,
    },
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  });

  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });
  chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });

  const ma20Series = chart.addLineSeries({
    color: '#4e8ef7',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  const ma200Series = chart.addLineSeries({
    color: '#f59e0b',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // ResizeObserver watches the chart div directly — no manual header/footer subtraction needed
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      chart.applyOptions({ width: Math.floor(width), height: Math.max(0, Math.floor(height)) });
    }
  });

  // Store state
  widgets.set(id, {
    id, symbol, exchange, currency, name,
    timeframe: '5 mins',
    chart, candleSeries, volumeSeries, ma20Series, ma200Series,
    bars: [],
    barCount: 0, observer,
    ma20Enabled: false, ma200Enabled: false,
    scope: '1d', pendingScope: null, savedTimeframe: null,
    markovData: null,
    overlayTimer: null,
    overlayProgress: 0,
  });

  // Wire events
  ma20Cb.addEventListener('change', () => {
    const w = widgets.get(id);
    w.ma20Enabled = ma20Cb.checked;
    w.ma20Series.setData(w.ma20Enabled ? calculateMA(w.bars, 20) : []);
  });
  ma200Cb.addEventListener('change', () => {
    const w = widgets.get(id);
    w.ma200Enabled = ma200Cb.checked;
    w.ma200Series.setData(w.ma200Enabled ? calculateMA(w.bars, 200) : []);
  });
  tfSelect.addEventListener('change', () => resubscribeWidget(id));
  expandBtn.addEventListener('click', () => toggleExpand(id));
  closeBtn.addEventListener('click', () => destroyWidget(id));

  // Size chart after layout, then observe
  requestAnimationFrame(() => {
    chart.applyOptions({
      width: chartDiv.clientWidth,
      height: Math.max(0, chartDiv.clientHeight),
    });
    observer.observe(chartDiv);
  });

  // Subscribe
  ws.send(JSON.stringify({ type: 'subscribe', symbol, exchange, currency, timeframe: '5 mins', widgetId: id }));
}

function destroyWidget(id) {
  const w = widgets.get(id);
  if (!w) return;
  clearInterval(w.overlayTimer);
  w.observer.disconnect();
  w.chart.remove();
  ws.send(JSON.stringify({ type: 'unsubscribe', widgetId: id }));
  document.querySelector(`[data-widget-id="${id}"]`)?.remove();
  widgets.delete(id);
  if (expandedWidgetId === id) clearExpand();
}

function resubscribeWidget(id) {
  const w = widgets.get(id);
  if (!w) return;
  const tfSelect = document.querySelector(`[data-widget-id="${id}"] .widget-timeframe`);
  w.timeframe = tfSelect.value;
  w.pendingClear = true;
  w.barCount = 0;
  w.bars = [];
  ws.send(JSON.stringify({ type: 'unsubscribe', widgetId: id }));
  ws.send(JSON.stringify({
    type: 'subscribe',
    symbol: w.symbol, exchange: w.exchange, currency: w.currency,
    timeframe: w.timeframe, widgetId: id,
  }));
}

// --- Expand / collapse ---
function toggleExpand(id) {
  if (expandedWidgetId === id) {
    clearExpand();
    return;
  }
  if (expandedWidgetId !== null) clearExpand();
  expandedWidgetId = id;
  const el = document.querySelector(`[data-widget-id="${id}"]`);
  el.classList.add('widget--expanded');

  requestAnimationFrame(() => {
    const w = widgets.get(id);
    if (!w) return;
    if (!w.scope || w.scope === '1d') applyTailZoom(id);
    else if (DAILY_SCOPES.has(w.scope)) applyDailyScopeZoom(id);
    else { const r = getScopeRange(w.scope); if (r) w.chart.timeScale().setVisibleRange(r); }
  });
}

function clearExpand() {
  if (expandedWidgetId === null) return;
  document.querySelector(`[data-widget-id="${expandedWidgetId}"]`)?.classList.remove('widget--expanded');
  expandedWidgetId = null;
}

// --- Status ---
function onStatus({ connected: c, mode }) {
  const wasConnected = connected;
  connected = c;
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const connectBtn = document.getElementById('connect-btn');

  dot.className = `dot ${c ? 'connected' : 'disconnected'}`;
  text.textContent = c ? `Connected · ${mode}` : 'Disconnected';
  connectBtn.disabled = false;
  connectBtn.textContent = c ? 'Disconnect' : 'Connect';

  if (mode) document.getElementById('mode-select').value = mode;

  if (c && !wasConnected && widgets.size > 0) {
    for (const [id, w] of widgets) {
      w.candleSeries.setData([]);
      w.volumeSeries.setData([]);
      w.barCount = 0;
      ws.send(JSON.stringify({
        type: 'subscribe',
        symbol: w.symbol, exchange: w.exchange, currency: w.currency,
        timeframe: w.timeframe, widgetId: id,
      }));
    }
  }

}

// --- Connect button ---
document.getElementById('connect-btn').addEventListener('click', () => {
  if (connected) {
    ws.send(JSON.stringify({ type: 'disconnect' }));
  } else {
    const mode = document.getElementById('mode-select').value;
    document.getElementById('connect-btn').textContent = 'Connecting…';
    document.getElementById('connect-btn').disabled = true;
    ws.send(JSON.stringify({ type: 'connect', mode }));
  }
});

// --- Toast ---
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = message;
  toast.className = `toast ${type}`;
}

document.getElementById('toast-close').addEventListener('click', () => {
  document.getElementById('toast').classList.add('hidden');
});

// --- Symbol search ---
document.getElementById('symbol-input').addEventListener('input', (e) => {
  const val = e.target.value.trim();
  searchEnabled = true;
  clearTimeout(searchTimer);
  if (!val) { hideDropdown(); return; }
  searchTimer = setTimeout(() => {
    if (connected) ws.send(JSON.stringify({ type: 'search', pattern: val }));
  }, 300);
});

document.getElementById('symbol-input').addEventListener('keydown', (e) => {
  const dd = document.getElementById('search-dropdown');
  const items = dd.querySelectorAll('.search-item');
  const active = dd.querySelector('.search-item.active');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = active ? active.nextElementSibling : items[0];
    if (next) { active?.classList.remove('active'); next.classList.add('active'); }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = active?.previousElementSibling;
    if (prev) { active.classList.remove('active'); prev.classList.add('active'); }
  } else if (e.key === 'Enter') {
    if (active) active.click();
  } else if (e.key === 'Escape') {
    hideDropdown();
  }
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.search-wrap')) hideDropdown();
  if (!e.target.closest('.markov-popup') && !e.target.closest('.widget-state')) {
    document.querySelectorAll('.markov-popup:not(.hidden)').forEach(el => el.classList.add('hidden'));
  }
});

function showDropdown(results) {
  const dd = document.getElementById('search-dropdown');
  if (!results.length) { hideDropdown(); return; }

  dd.innerHTML = '';
  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'search-item';
    item.dataset.symbol = r.symbol;
    item.dataset.name = r.name || '';
    item.dataset.exchange = r.exchange;
    item.dataset.currency = r.currency;

    const symbolSpan = document.createElement('span');
    symbolSpan.className = 'si-symbol';
    if (r.name) {
      symbolSpan.textContent = `${r.name} `;
      const ticker = document.createElement('span');
      ticker.className = 'si-ticker';
      ticker.textContent = `(${r.symbol})`;
      symbolSpan.appendChild(ticker);
    } else {
      symbolSpan.textContent = r.symbol;
    }

    const meta = document.createElement('span');
    meta.className = 'si-meta';
    meta.textContent = `${r.exchange} · ${r.currency}`;

    item.appendChild(symbolSpan);
    item.appendChild(meta);

    item.addEventListener('click', () => {
      clearTimeout(searchTimer);
      searchEnabled = false;
      hideDropdown();
      document.getElementById('symbol-input').value = '';
      createWidget(r.symbol, r.exchange, r.currency, r.name || '');
    });

    dd.appendChild(item);
  });

  dd.classList.remove('hidden');
}

function hideDropdown() {
  document.getElementById('search-dropdown').classList.add('hidden');
}

// --- Scanner ---
document.getElementById('scanner-toggle-btn').addEventListener('click', () => {
  document.getElementById('scanner-panel').classList.toggle('hidden');
});

document.getElementById('scanner-scan-btn').addEventListener('click', () => {
  if (!connected) { showToast('Connect to IBKR first', 'error'); return; }
  const location = document.getElementById('scanner-location').value;
  const scanCode = document.getElementById('scanner-code').value;
  ws.send(JSON.stringify({ type: 'scanMarket', location, scanCode }));
});

function onScanStart() {
  const results = document.getElementById('scanner-results');
  results.innerHTML = '<div class="scan-loading"><div class="spinner"></div>Scanning…</div>';
  document.getElementById('scanner-scan-btn').disabled = true;
}

function onScanResult(r) {
  const results = document.getElementById('scanner-results');
  const loading = results.querySelector('.scan-loading');
  if (loading) loading.remove();

  const row = document.createElement('div');
  row.className = 'scan-row';

  const rank = document.createElement('span');
  rank.className = 'scan-rank';
  rank.textContent = (r.rank ?? 0) + 1;

  const info = document.createElement('div');
  info.style.flex = '1';
  info.style.overflow = 'hidden';
  const sym = document.createElement('span');
  sym.className = 'scan-symbol';
  sym.textContent = r.name ? `${r.name} (${r.symbol})` : r.symbol;
  info.appendChild(sym);

  const priceWrap = document.createElement('div');
  priceWrap.className = 'scan-price';
  const priceSpan = document.createElement('span');
  priceSpan.textContent = r.price != null ? r.price.toFixed(2) : '—';
  const changeSpan = document.createElement('span');
  changeSpan.className = `scan-change ${r.change > 0 ? 'up' : r.change < 0 ? 'down' : ''}`;
  changeSpan.textContent = r.change != null ? `${r.change > 0 ? '+' : ''}${r.change.toFixed(2)}%` : '';
  priceWrap.appendChild(priceSpan);
  priceWrap.appendChild(changeSpan);

  row.appendChild(rank);
  row.appendChild(info);
  row.appendChild(priceWrap);

  row.addEventListener('click', () => {
    createWidget(r.symbol, r.exchange, r.currency || 'USD', r.name || '');
  });

  results.appendChild(row);
}

function onScanComplete() {
  document.getElementById('scanner-scan-btn').disabled = false;
  const results = document.getElementById('scanner-results');
  const loading = results.querySelector('.scan-loading');
  if (loading) loading.remove();
  if (!results.children.length) {
    results.innerHTML = '<div class="scan-loading">No results</div>';
  }
}

