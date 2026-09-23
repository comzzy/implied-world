/**
 * Demo freezes so Lattice / Kill / Atlas work offline without MCP.
 * Realistic overnight rToken snapshots — no trade-direction language.
 */

const { solve } = require('./solver');
const { hoursToNextUsCashOpen } = require('../shared/rtoken');

const CASH = { NVDA: 120.4, TSLA: 248.9, AAPL: 191.2 };
const PREM = { NVDA: 0.0095, TSLA: 0.0125, AAPL: 0.0075 };
const THIN = { NVDA: false, TSLA: true, AAPL: false };
const EVENT = { NVDA: 'geopolitics', TSLA: 'earnings', AAPL: 'cpi_fomc' };
const BTC = 0.0; // flat residual so −3% atlas shocks visibly stress high-event names

function field(value, tag = 'assumed', extra = {}) {
  return { value, tag, source: 'sample', ...extra };
}

/**
 * @param {string} [symbol]
 * @returns {object} freeze shaped like freezeInputs()
 */
function sampleFreeze(symbol = 'NVDA') {
  const sym = String(symbol || 'NVDA').toUpperCase();
  const cash = CASH[sym] ?? 100;
  const prem = PREM[sym] ?? 0.007;
  const rtoken = cash * (1 + prem);
  const hours = hoursToNextUsCashOpen(new Date());
  const eventClass = EVENT[sym] || 'none';
  const eventImportance =
    eventClass === 'earnings' ? 0.85 : eventClass === 'cpi_fomc' ? 0.7 : eventClass === 'geopolitics' ? 0.45 : 0.1;

  const peers = {};
  for (const p of ['NVDA', 'TSLA', 'AAPL']) {
    if (p === sym) continue;
    peers[p] = field(PREM[p], 'assumed', { note: 'Sample peer premium.' });
  }

  return {
    symbol: sym,
    displayName: sym === 'NVDA' ? 'NVIDIA' : sym === 'TSLA' ? 'Tesla' : sym === 'AAPL' ? 'Apple' : sym,
    asOf: new Date().toISOString(),
    cashClose: field(cash, 'assumed', { note: 'Sample cash close for demo.' }),
    rtoken: field(rtoken, 'assumed', { note: 'Sample rToken proxy for demo.' }),
    premium: field(prem, 'assumed', { formula: '(rtoken - cash) / cash', note: 'Sample freeze.' }),
    hoursToOpen: {
      hours: hours.hours,
      nextOpenEt: hours.nextOpenEt,
      inSession: hours.inSession,
      tag: 'computed',
    },
    btc24hReturn: field(BTC, 'assumed', { note: 'Sample BTC residual for demo.' }),
    nasdaqLast: field(null, 'assumed', { note: 'Sample path; no live Nasdaq.' }),
    eventClass: field(eventClass, 'assumed', { note: 'Sample calendar class.' }),
    eventImportance,
    thinWrapper: field(Boolean(THIN[sym]), 'assumed', {
      note: 'Sample thin-wrapper flag.',
    }),
    bookSpread: field(THIN[sym] ? 0.0012 : 0.0006, 'assumed'),
    bookDepth: field(THIN[sym] ? 8000 : 40000, 'assumed'),
    peerPremiums: peers,
    sources: [
      { name: 'sample_freeze', ok: true, tag: 'assumed', source: 'demo' },
    ],
    style: 'weekend_swing',
    thesis: null,
    _sample: true,
  };
}

/** Freezes for all three names. */
function sampleFreezesAll() {
  return {
    NVDA: sampleFreeze('NVDA'),
    TSLA: sampleFreeze('TSLA'),
    AAPL: sampleFreeze('AAPL'),
  };
}

/** Sample freeze + solved band for localStorage / demo. */
function sampleDeskPayload(symbol = 'NVDA') {
  const freeze = sampleFreeze(symbol);
  const band = solve(freeze);
  return {
    freeze,
    band,
    symbol: freeze.symbol,
    at: new Date().toISOString(),
  };
}

module.exports = {
  sampleFreeze,
  sampleFreezesAll,
  sampleDeskPayload,
};
