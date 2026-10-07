/**
 * Bitget public REST (no auth) — fallback when MCP price calls fail.
 * Market endpoints only. Never invents values; returns ok:false on any failure.
 * Note: Bitget REST has no US equity cash-close endpoint, so cash close is not served here.
 */
const BASE = 'https://api.bitget.com';
const SOURCE = 'bitget-rest';

async function getJson(path, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== '00000') throw new Error(`code ${j.code} ${j.msg || ''}`.trim());
    return j.data;
  } finally {
    clearTimeout(t);
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** RWA stock perpetual ticker {SYM}USDT (same instrument the MCP path uses). */
async function fetchRtokenQuote(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const pair = `${sym}USDT`;
  const path = `/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=${pair}`;
  try {
    const row = (await getJson(path))?.[0];
    const price = num(row?.lastPr);
    if (!row || !(price > 0)) throw new Error('no price');
    return {
      ok: true,
      symbol: sym,
      pair,
      price,
      bid: num(row.bidPr),
      ask: num(row.askPr),
      exchange: 'bitget',
      instrument: row.symbol || pair,
      tag: 'observed',
      source: SOURCE,
      tool: 'rest:/api/v2/mix/market/ticker',
      kind: 'wrapper_rtoken',
      asOf: row.ts ? new Date(Number(row.ts)).toISOString() : null,
      note: `Observed wrapper via Bitget public REST (${pair} RWA perpetual) after MCP failed.`,
    };
  } catch (err) {
    return { ok: false, symbol: sym, pair, tag: 'source_failed', source: SOURCE, error: `rest ticker: ${err.message}` };
  }
}

async function fetchOrderBook(symbol, limit = 5) {
  const sym = String(symbol || '').toUpperCase();
  const pair = `${sym}USDT`;
  const path = `/api/v2/mix/market/merge-depth?productType=USDT-FUTURES&symbol=${pair}&limit=${limit}`;
  try {
    const d = await getJson(path);
    const bids = d?.bids || [];
    const asks = d?.asks || [];
    const bestBid = num(bids[0]?.[0]);
    const bestAsk = num(asks[0]?.[0]);
    if (!(bestBid > 0) || !(bestAsk > 0)) throw new Error('empty book');
    const mid = (bestBid + bestAsk) / 2;
    let depthNotional = 0;
    const levels = Math.min(5, bids.length, asks.length);
    for (let i = 0; i < levels; i++) {
      depthNotional += Number(bids[i][0]) * Number(bids[i][1]) + Number(asks[i][0]) * Number(asks[i][1]);
    }
    return {
      ok: true,
      symbol: sym,
      pair,
      bestBid,
      bestAsk,
      bidQty: num(bids[0]?.[1]),
      askQty: num(asks[0]?.[1]),
      spread: (bestAsk - bestBid) / mid,
      depthNotional,
      mid,
      tag: 'observed',
      source: SOURCE,
      tool: 'rest:/api/v2/mix/market/merge-depth',
    };
  } catch (err) {
    return { ok: false, symbol: sym, pair, tag: 'source_failed', source: SOURCE, error: `rest depth: ${err.message}` };
  }
}

/** BTC 24h return from spot BTCUSDT ticker (change24h is a decimal fraction). */
async function fetchBtc24hReturn() {
  try {
    const row = (await getJson('/api/v2/spot/market/tickers?symbol=BTCUSDT'))?.[0];
    const v = num(row?.change24h);
    if (v == null) throw new Error('no change24h');
    return {
      ok: true,
      value: v,
      tag: 'observed',
      source: SOURCE,
      tool: 'rest:/api/v2/spot/market/tickers#BTCUSDT.change24h',
    };
  } catch (err) {
    return { ok: false, value: null, tag: 'source_failed', source: SOURCE, error: `rest btc: ${err.message}` };
  }
}

module.exports = { BASE, SOURCE, fetchRtokenQuote, fetchOrderBook, fetchBtc24hReturn };
