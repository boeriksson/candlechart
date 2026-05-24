import ibkr from './ibkr.js';
import { getBars, putBars, getMarkov, putMarkov } from './db.js';

function toDateInt(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function calculateStates(bars) {
  const states = [];
  for (let i = 20; i < bars.length; i++) {
    const cum20d = (bars[i].close - bars[i - 20].close) / bars[i - 20].close * 100;
    const dailyReturn = (bars[i].close - bars[i - 1].close) / bars[i - 1].close * 100;
    states.push({
      date: toDateInt(bars[i].time),
      state: cum20d >= 5 ? 'BULL' : cum20d <= -5 ? 'BEAR' : 'SIDEWAYS',
      dailyReturn,
      cum20dReturn: cum20d,
    });
  }
  return states;
}

const TRANS_KEYS = [
  'BULL_BULL', 'BULL_BEAR', 'BULL_SIDEWAYS',
  'BEAR_BULL', 'BEAR_BEAR', 'BEAR_SIDEWAYS',
  'SIDEWAYS_BULL', 'SIDEWAYS_BEAR', 'SIDEWAYS_SIDEWAYS',
];

function calculateTransitions(states) {
  const t = Object.fromEntries(TRANS_KEYS.map(k => [k, 0]));
  for (let i = 1; i < states.length; i++) {
    const key = `${states[i - 1].state}_${states[i].state}`;
    if (key in t) t[key]++;
  }
  return t;
}

// --- Enriched parallel analysis ---

function buildProbMatrix(t) {
  const raw = [
    [t.BEAR_BEAR||0,     t.BEAR_SIDEWAYS||0,     t.BEAR_BULL||0],
    [t.SIDEWAYS_BEAR||0, t.SIDEWAYS_SIDEWAYS||0, t.SIDEWAYS_BULL||0],
    [t.BULL_BEAR||0,     t.BULL_SIDEWAYS||0,     t.BULL_BULL||0],
  ];
  return raw.map(row => {
    const sum = row.reduce((a, b) => a + b, 0) || 1;
    return row.map(x => x / sum);
  });
}

function stationaryDistribution(P) {
  let v = [1/3, 1/3, 1/3];
  for (let iter = 0; iter < 1000; iter++) {
    const next = [0, 0, 0];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        next[j] += v[i] * P[i][j];
    const diff = Math.max(...next.map((x, k) => Math.abs(x - v[k])));
    v = next;
    if (diff < 1e-10) break;
  }
  return v;
}

function walkForwardBacktest(states, minTrain = 252) {
  if (states.length < minTrain + 30)
    return { sharpe: null, maxDrawdown: null, nTrades: 0 };

  const idx = { BEAR: 0, SIDEWAYS: 1, BULL: 2 };
  const lab = states.map(s => idx[s.state]);
  const rets = states.map(s => s.dailyReturn / 100);

  const counts = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < minTrain - 1; i++) counts[lab[i]][lab[i+1]]++;

  const sr = [];
  for (let t = minTrain; t < lab.length - 1; t++) {
    const P = counts.map(row => {
      const sum = row.reduce((a, b) => a + b, 0) || 1;
      return row.map(x => x / sum);
    });
    const cur = lab[t];
    const signal = P[cur][2] - P[cur][0];
    sr.push(Math.sign(signal) * rets[t + 1]);
    counts[lab[t - 1]][lab[t]]++;
  }

  if (!sr.length) return { sharpe: null, maxDrawdown: null, nTrades: 0 };

  const n = sr.length;
  const mean = sr.reduce((a, b) => a + b, 0) / n;
  const variance = sr.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 1e-10 ? mean / std * Math.sqrt(252) : null;

  let equity = 1, peak = 1, maxDD = 0;
  for (const r of sr) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return { sharpe, maxDrawdown: maxDD, nTrades: n };
}

function computeEnriched(transitions, currentState, states) {
  const P = buildProbMatrix(transitions);
  const pi = stationaryDistribution(P);
  const stateIdx = { BEAR: 0, SIDEWAYS: 1, BULL: 2 };
  const cur = stateIdx[currentState] ?? 2;
  const next = P[cur];

  const wf = states ? walkForwardBacktest(states) : { sharpe: null, maxDrawdown: null, nTrades: 0 };

  return {
    signal: next[2] - next[0],
    nextStateProbabilities: { bear: next[0], sideways: next[1], bull: next[2] },
    stationaryDistribution: { bear: pi[0], sideways: pi[1], bull: pi[2] },
    persistenceDiagonal: { bear: P[0][0], sideways: P[1][1], bull: P[2][2] },
    walkForward: wf,
  };
}

function enrichedFromRecord(rec) {
  const t = Object.fromEntries(TRANS_KEYS.map(k => [k, rec[k] || 0]));
  const base = computeEnriched(t, rec.currentState, null);
  base.walkForward = {
    sharpe: rec.wfSharpe ?? null,
    maxDrawdown: rec.wfMaxDrawdown ?? null,
    nTrades: rec.wfNTrades ?? 0,
  };
  return base;
}

export async function runMarkovAnalysis(symbol, exchange, currency, widgetId, notify) {
  try {
    const cachedBars = await getBars(symbol, exchange, '1 day');
    let allBars;

    if (cachedBars.length === 0) {
      notify('analysisStatus', { widgetId, status: 'fetching', message: 'Fetching 20yr history…' });
      allBars = await ibkr.fetchHistorical(symbol, exchange, currency, '20 Y', '1 day');
      await putBars(symbol, exchange, '1 day', allBars);
    } else {
      const lastBar = cachedBars[cachedBars.length - 1];
      const daysSince = Math.ceil((Date.now() - lastBar.time * 1000) / 86400000);

      if (daysSince <= 1) {
        const existing = await getMarkov(symbol, exchange);
        if (existing) {
          // --- Old analysis ---
          notify('analysisResult', { widgetId, currentState: existing.currentState, transitions: existing });
          notify('analysisStatus', { widgetId, status: 'done' });
          // --- Enriched analysis (parallel) ---
          notify('enrichedResult', { widgetId, enriched: enrichedFromRecord(existing) });
          return;
        }
        allBars = cachedBars;
      } else {
        notify('analysisStatus', { widgetId, status: 'fetching', message: `Fetching ${daysSince} missing days…` });
        const duration = `${Math.min(daysSince + 5, 365)} D`;
        const newBars = await ibkr.fetchHistorical(symbol, exchange, currency, duration, '1 day');
        await putBars(symbol, exchange, '1 day', newBars);
        const lastCachedTime = lastBar.time;
        allBars = [...cachedBars, ...newBars.filter(b => b.time > lastCachedTime)];
      }
    }

    notify('analysisStatus', { widgetId, status: 'calculating', message: 'Calculating Markov projection…' });
    const states = calculateStates(allBars);
    const transitions = calculateTransitions(states);
    const lastState = states[states.length - 1];

    const markovRecord = {
      ...transitions,
      currentState: lastState?.state,
      lastProcessedDate: lastState?.date,
      updatedAt: new Date().toISOString(),
    };
    await putMarkov(symbol, exchange, markovRecord);

    // --- Old analysis fires first ---
    notify('analysisResult', { widgetId, currentState: markovRecord.currentState, transitions });
    notify('analysisStatus', { widgetId, status: 'done' });

    // --- Enriched analysis runs after, saves extra fields ---
    setImmediate(async () => {
      try {
        notify('analysisStatus', { widgetId, status: 'calculating', message: 'Running enriched analysis…' });
        const enriched = computeEnriched(transitions, lastState?.state, states);
        markovRecord.wfSharpe = enriched.walkForward.sharpe;
        markovRecord.wfMaxDrawdown = enriched.walkForward.maxDrawdown;
        markovRecord.wfNTrades = enriched.walkForward.nTrades;
        await putMarkov(symbol, exchange, markovRecord);
        notify('enrichedResult', { widgetId, enriched });
        notify('analysisStatus', { widgetId, status: 'done' });
      } catch (err) {
        notify('analysisStatus', { widgetId, status: 'error', message: `Enriched analysis failed: ${err.message}` });
      }
    });

  } catch (err) {
    notify('analysisStatus', { widgetId, status: 'error', message: `Analysis failed: ${err.message}` });
  }
}
