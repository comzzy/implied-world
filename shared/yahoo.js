/**
 * Yahoo Finance chart API — fallback for US cash close (and Nasdaq session) only,
 * used when Bitget MCP equity_price_quote fails. Never invents values.
 * Cash close = most recent COMPLETED regular-session close.
 */
const SOURCE = 'yahoo-finance';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0';

async function fetchChart(symbol, timeoutMs = 5000) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  let lastErr = 'no response';
  for (const host of HOSTS) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(host + path, {
        signal: ctl.signal,
        headers: { 'User-Agent': UA, accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) throw new Error(j?.chart?.error?.description || 'empty chart');
      return res;
    } catch (err) {
      lastErr = err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message;
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(lastErr);
}

/** Completed daily bars [{t, close}] — drops today's bar while the regular session is still open. */
function completedBars(res, nowMs = Date.now()) {
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const bars = ts
    .map((t, i) => ({ t: t * 1000, close: Math.round(Number(closes[i]) * 1e4) / 1e4 }))
    .filter((b) => Number.isFinite(b.close) && b.close > 0);
  const reg = res.meta?.currentTradingPeriod?.regular;
  if (bars.length && reg && reg.start && reg.end) {
    const last = bars[bars.length - 1];
    const startMs = reg.start * 1000;
    const endMs = reg.end * 1000;
    if (last.t >= startMs - 6 * 3600e3 && nowMs < endMs) bars.pop();
  }
  return bars;
}

const etDate = (ms) =>
  new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function fetchCashClose(symbol) {
  const sym = String(symbol || '').toUpperCase();
  try {
    const res = await fetchChart(sym);
    const bars = completedBars(res);
    const last = bars[bars.length - 1];
    if (!last) throw new Error('no completed session close');
    return {
      ok: true,
      symbol: sym,
      lastClose: last.close,
      sessionDate: etDate(last.t),
      tag: 'observed',
      source: SOURCE,
      tool: 'yahoo:v8/finance/chart#completed_close',
      note: `Last completed US regular-session close (${etDate(last.t)}) via Yahoo Finance after Bitget equity quote failed.`,
    };
  } catch (err) {
    return { ok: false, symbol: sym, tag: 'source_failed', source: SOURCE, error: `yahoo: ${err.message}` };
  }
}

/** Nasdaq Composite (^IXIC) return over the last completed session. */
async function fetchNasdaqLastSession() {
  try {
    const res = await fetchChart('^IXIC');
    const bars = completedBars(res);
    if (bars.length < 2) throw new Error('need two completed sessions');
    const a = bars[bars.length - 2];
    const b = bars[bars.length - 1];
    return {
      ok: true,
      value: (b.close - a.close) / a.close,
      tag: 'observed',
      source: SOURCE,
      tool: 'yahoo:v8/finance/chart#^IXIC',
      note: `Nasdaq Composite (^IXIC) last completed session ${etDate(b.t)} vs ${etDate(a.t)} via Yahoo Finance.`,
    };
  } catch (err) {
    return { ok: false, value: null, tag: 'source_failed', source: SOURCE, error: `yahoo ^IXIC: ${err.message}` };
  }
}

module.exports = { SOURCE, fetchCashClose, fetchNasdaqLastSession, completedBars };
