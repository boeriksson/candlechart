import ibkr from './ibkr.js';
import { putBars, getMarkov, putMarkov, putStates } from './db.js';

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

export async function runMarkovAnalysis(symbol, exchange, currency, widgetId, notify) {
  try {
    const existing = await getMarkov(symbol, exchange);

    let newStates = [];
    let transitions = {};

    if (!existing) {
      notify('analysisStatus', { widgetId, status: 'fetching', message: 'Fetching 20yr history…' });
      const bars = await ibkr.fetchHistorical(symbol, exchange, currency, '20 Y', '1 day');
      await putBars(symbol, exchange, '1 day', bars);

      notify('analysisStatus', { widgetId, status: 'calculating', message: 'Calculating Markov projection…' });
      newStates = calculateStates(bars);
      transitions = calculateTransitions(newStates);
      await putStates(symbol, exchange, newStates);
    } else {
      const last = existing.lastProcessedDate;
      const lastDate = new Date(
        `${String(last).slice(0, 4)}-${String(last).slice(4, 6)}-${String(last).slice(6, 8)}T00:00:00Z`
      );
      const daysSince = Math.ceil((Date.now() - lastDate.getTime()) / 86400000);

      if (daysSince <= 1) {
        notify('analysisResult', { widgetId, currentState: existing.currentState, transitions: existing });
        notify('analysisStatus', { widgetId, status: 'done' });
        return;
      }

      notify('analysisStatus', { widgetId, status: 'calculating', message: 'Updating Markov projection…' });
      const duration = `${Math.min(daysSince + 25, 365)} D`;
      const recentBars = await ibkr.fetchHistorical(symbol, exchange, currency, duration, '1 day');
      await putBars(symbol, exchange, '1 day', recentBars);

      newStates = calculateStates(recentBars);
      const newOnly = newStates.filter(s => s.date > last);
      if (newOnly.length > 0) await putStates(symbol, exchange, newOnly);

      transitions = Object.fromEntries(TRANS_KEYS.map(k => [k, existing[k] || 0]));
      const delta = calculateTransitions(newStates);
      TRANS_KEYS.forEach(k => { transitions[k] += delta[k]; });
    }

    const lastState = newStates[newStates.length - 1];
    const markovRecord = {
      ...transitions,
      currentState: lastState?.state ?? existing?.currentState,
      lastProcessedDate: lastState?.date ?? existing?.lastProcessedDate,
      updatedAt: new Date().toISOString(),
    };
    await putMarkov(symbol, exchange, markovRecord);

    notify('analysisResult', { widgetId, currentState: markovRecord.currentState, transitions });
    notify('analysisStatus', { widgetId, status: 'done' });
  } catch (err) {
    notify('analysisStatus', { widgetId, status: 'error', message: `Analysis failed: ${err.message}` });
  }
}
