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
    w.pendingClear = false;
  }
  w.barCount++;
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
  const el = document.querySelector(`[data-widget-id="${msg.widgetId}"] .widget-chart`);
  const chartWidth = el ? el.clientWidth : 0;
  const barsToShow = Math.max(10, Math.floor(chartWidth / 7));
  const range = w.chart.timeScale().getVisibleLogicalRange();
  if (range) {
    w.chart.timeScale().setVisibleLogicalRange({
      from: range.to - barsToShow,
      to: range.to,
    });
  } else {
    w.chart.timeScale().fitContent();
  }
}

function onRealtimeBar(msg) {
  const w = widgets.get(msg.widgetId);
  if (!w) return;
  w.candleSeries.update(msg.bar);
  w.volumeSeries.update({
    time: msg.bar.time,
    value: msg.bar.volume,
    color: msg.bar.close >= msg.bar.open ? '#26a69a55' : '#ef535055',
  });
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

  const tfSelect = document.createElement('select');
  tfSelect.className = 'widget-timeframe';
  [['1 min','1m'],['5 mins','5m'],['15 mins','15m'],['30 mins','30m'],['1 hour','1h'],['1 day','1D']].forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === '5 mins') opt.selected = true;
    tfSelect.appendChild(opt);
  });

  const expandBtn = document.createElement('button');
  expandBtn.className = 'widget-expand-btn';
  expandBtn.title = 'Expand';
  expandBtn.textContent = '⤢';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'widget-close-btn';
  closeBtn.title = 'Remove';
  closeBtn.textContent = '×';

  header.appendChild(title);
  header.appendChild(tfSelect);
  header.appendChild(expandBtn);
  header.appendChild(closeBtn);

  const chartDiv = document.createElement('div');
  chartDiv.className = 'widget-chart';

  widget.appendChild(header);
  widget.appendChild(chartDiv);
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

  // ResizeObserver for responsive chart sizing
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      chart.applyOptions({
        width: Math.floor(width),
        height: Math.max(0, Math.floor(height) - 36),
      });
    }
  });

  // Store state
  widgets.set(id, {
    id, symbol, exchange, currency, name,
    timeframe: '5 mins',
    chart, candleSeries, volumeSeries,
    barCount: 0, observer,
  });

  // Wire events
  tfSelect.addEventListener('change', () => resubscribeWidget(id));
  expandBtn.addEventListener('click', () => toggleExpand(id));
  closeBtn.addEventListener('click', () => destroyWidget(id));

  // Size chart after layout, then observe
  requestAnimationFrame(() => {
    chart.applyOptions({
      width: chartDiv.clientWidth,
      height: Math.max(0, chartDiv.clientHeight),
    });
    observer.observe(widget);
  });

  // Subscribe
  ws.send(JSON.stringify({ type: 'subscribe', symbol, exchange, currency, timeframe: '5 mins', widgetId: id }));
}

function destroyWidget(id) {
  const w = widgets.get(id);
  if (!w) return;
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
  w.pendingClear = true;  // clear series on first incoming bar, not now
  w.barCount = 0;
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

  // Wait for ResizeObserver to apply new dimensions, then zoom to tail
  requestAnimationFrame(() => {
    const w = widgets.get(id);
    if (!w) return;
    const chartWidth = el.querySelector('.widget-chart').clientWidth;
    const barsToShow = Math.floor(chartWidth / 7);
    const range = w.chart.timeScale().getVisibleLogicalRange();
    if (range) {
      w.chart.timeScale().setVisibleLogicalRange({
        from: range.to - barsToShow,
        to: range.to,
      });
    }
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
