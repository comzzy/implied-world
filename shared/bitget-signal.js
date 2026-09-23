/**
 * Bitget / Noxiaohao datahub MCP — macro, news, BTC residual proxies.
 * Endpoint: https://datahub.noxiaohao.com/mcp
 *
 * Profiled (2026-09-23): crypto_price / crypto_market / global_assets /
 * tradfi_news / news_feed hang (≥8–12s). crypto_derivatives ticker_24h
 * responds ~200–300ms with change_pct. Prefer that path; fall back to
 * Bitget US do_query or CoinGecko public — never invent, always tag source.
 */

const { createMcpClient } = require('./mcp-http');

const MCP_URL = 'https://datahub.noxiaohao.com/mcp';
const SOURCE = 'bitget-signal';
/** Per-call default: short, no retry — hanging tools must not burn the desk. */
const CALL_OPTS = { timeoutMs: 10000, retries: 0 };
const FAST_OPTS = { timeoutMs: 8000, retries: 0 };

const client = createMcpClient(MCP_URL, SOURCE, {
  timeoutMs: 10000,
  retries: 0,
  backoffMs: 300,
});

let toolsFailed = false;
let cachedTools = null;
let failCount = 0;

async function listTools(callOpts = CALL_OPTS) {
  if (toolsFailed && failCount >= 3) {
    return { ok: false, error: 'cached unreachable', source: SOURCE, unreachable: true };
  }
  if (cachedTools) return cachedTools;
  const out = await client.listTools(callOpts);
  if (out.ok) {
    cachedTools = out;
    toolsFailed = false;
    failCount = 0;
  } else {
    failCount += 1;
    if (failCount >= 3) toolsFailed = true;
  }
  return out;
}

async function callTool(name, args = {}, callOpts = {}) {
  if (toolsFailed && failCount >= 3) {
    return { ok: false, error: 'mcp unreachable (fail-fast)', source: SOURCE };
  }
  const opts = { ...CALL_OPTS, ...callOpts };
  const out = await client.callTool(name, args, opts);
  if (!out.ok && /timeout|unreachable|ECONNRESET|fetch failed|AbortError/i.test(out.error || '')) {
    failCount += 1;
    if (failCount >= 3) toolsFailed = true;
  } else if (out.ok) {
    failCount = Math.max(0, failCount - 1);
  }
  return out;
}

function parsePayload(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * BTC 24h return.
 * 1) Signal crypto_derivatives ticker_24h (fast path)
 * 2) Bitget US do_query crypto_futures_ticker BTCUSDT
 * 3) CoinGecko simple/price (public) — last resort
 */
async function fetchBtc24hReturn() {
  await withSoftTimeout(listTools(FAST_OPTS), 5000);

  if (!(toolsFailed && failCount >= 3)) {
    const attempts = [
      { name: 'crypto_derivatives', args: { action: 'ticker_24h', symbol: 'BTC/USDT' } },
      { name: 'crypto_derivatives', args: { action: 'ticker_24h', symbol: 'BTCUSDT' } },
    ];
    for (const a of attempts) {
      const out = await callTool(a.name, a.args, FAST_OPTS);
      if (!out.ok) continue;
      const payload = parsePayload(out.result);
      if (payload?.error) continue;
      const ret = extractReturn(payload, [
        'change_pct',
        'changePercent',
        'priceChangePercent',
        'price_change_percentage_24h',
        'change24h',
        'pctChange',
        'return24h',
      ]);
      if (ret != null) {
        return { ok: true, value: ret, tag: 'observed', source: SOURCE, tool: a.name };
      }
      const derived = deriveFromOpenLast(payload);
      if (derived != null) {
        return { ok: true, value: derived, tag: 'observed', source: SOURCE, tool: a.name };
      }
    }
  }

  const us = await fetchBtcFromBitgetUs();
  if (us.ok) return us;

  const cg = await fetchBtcFromCoinGecko();
  if (cg.ok) return cg;

  return {
    ok: false,
    value: null,
    tag: 'source_failed',
    source: SOURCE,
    error: [
      'signal crypto_derivatives failed/empty',
      us.error && `bitget-us: ${us.error}`,
      cg.error && `coingecko: ${cg.error}`,
    ]
      .filter(Boolean)
      .join(' | '),
  };
}

async function fetchBtcFromBitgetUs() {
  try {
    const bitgetUs = require('./bitget-us');
    const out = await bitgetUs.callTool(
      'do_query',
      {
        entry_id: 'crypto_futures_ticker',
        params: { symbol: 'BTCUSDT', exchange: 'bitget' },
      },
      { timeoutMs: 10000, retries: 0 }
    );
    if (!out.ok) {
      return { ok: false, error: out.error, tag: 'source_failed', source: 'bitget-us' };
    }
    const payload = parsePayload(out.result);
    if (payload?.success === false) {
      return { ok: false, error: String(payload.error || 'query failed'), tag: 'source_failed', source: 'bitget-us' };
    }
    const data = payload?.data?.results ?? payload?.data ?? payload;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object') {
      return { ok: false, error: 'empty ticker', tag: 'source_failed', source: 'bitget-us' };
    }
    const derived = deriveFromOpenLast(row);
    if (derived != null) {
      return {
        ok: true,
        value: derived,
        tag: 'observed',
        source: 'bitget-us',
        tool: 'do_query:crypto_futures_ticker',
        note: 'BTC 24h via Bitget US futures ticker (Signal crypto_* hung).',
      };
    }
    const ret = extractReturn(row, ['change_percent', 'change_pct', 'changePercent']);
    if (ret != null) {
      return {
        ok: true,
        value: ret,
        tag: 'observed',
        source: 'bitget-us',
        tool: 'do_query:crypto_futures_ticker',
        note: 'BTC 24h via Bitget US futures ticker (Signal crypto_* hung).',
      };
    }
    return { ok: false, error: 'no return field', tag: 'source_failed', source: 'bitget-us' };
  } catch (err) {
    return { ok: false, error: err.message, tag: 'source_failed', source: 'bitget-us' };
  }
}

async function fetchBtcFromCoinGecko() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url =
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true';
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, tag: 'source_failed', source: 'coingecko-public' };
    }
    const data = await res.json();
    const pct = Number(data?.bitcoin?.usd_24h_change);
    if (!Number.isFinite(pct)) {
      return { ok: false, error: 'no usd_24h_change', tag: 'source_failed', source: 'coingecko-public' };
    }
    return {
      ok: true,
      value: pct / 100,
      tag: 'observed',
      source: 'coingecko-public',
      tool: 'simple/price',
      note: 'BTC 24h via CoinGecko public API (Signal + Bitget US unavailable).',
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timeout 8000ms' : err.message;
    return { ok: false, error: msg, tag: 'source_failed', source: 'coingecko-public' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Nasdaq / QQQ last-session return.
 * Signal global_assets profiled hang — prefer Bitget US equity_price_quote QQQ.
 */
async function fetchNasdaqLastSession() {
  // Signal global_assets profiled hang (≥10s) and races the shared MCP session
  // when run beside crypto_derivatives. Skip Signal; use Bitget US QQQ.
  try {
    const bitgetUs = require('./bitget-us');
    const q = await bitgetUs.fetchQuote('QQQ');
    if (q.ok && q.price != null && q.prevClose != null && q.prevClose > 0) {
      const ret = (q.price - q.prevClose) / q.prevClose;
      return {
        ok: true,
        value: ret,
        tag: 'observed',
        source: 'bitget-us',
        tool: 'do_query:equity_price_quote',
        note: 'Nasdaq proxy via QQQ equity quote on Bitget US (Signal global_assets hung).',
      };
    }
    return {
      ok: false,
      value: null,
      tag: 'source_failed',
      source: 'bitget-us',
      error: q.error || 'QQQ quote missing prev_close',
    };
  } catch (err) {
    return {
      ok: false,
      value: null,
      tag: 'source_failed',
      source: 'bitget-us',
      error: err.message,
    };
  }
}

/**
 * Event class. tradfi_news profiled hang (≥8–12s) — try once with short
 * timeout, else assumed none. Never invent earnings.
 */
async function fetchEventClass(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const tryTradfi = String(process.env.SIGNAL_TRY_EVENTS || '').toLowerCase() === '1';
  const checkedWindow = 'recent headlines + macro calendar (short timeout)';

  const assumedSkip = (error) => ({
    ok: false,
    value: 'none',
    tag: 'assumed',
    source: SOURCE,
    error,
    checked_window: checkedWindow,
    note:
      'Event lookup skipped on purpose (tradfi_news hangs). event_class=none (assumed). No event was verified — not the same as proving none exists. Not inventing earnings.',
  });

  const failed = (error, tool) => ({
    ok: false,
    value: 'none',
    tag: 'source_failed',
    source: SOURCE,
    tool: tool || undefined,
    error,
    checked_window: checkedWindow,
    note:
      'Event lookup failed or timed out. event_class=none for numbers. No event was verified — not inventing earnings/FOMC.',
  });

  const unverified = (tool, detail) => ({
    ok: true,
    value: 'none',
    tag: 'assumed',
    source: SOURCE,
    tool,
    checked_window: checkedWindow,
    note:
      'No dated matching event was verified in the checked window (not proof that none exists). ' +
      (detail || ''),
  });

  if (toolsFailed && failCount >= 3) {
    return failed('mcp unreachable');
  }

  await withSoftTimeout(listTools(FAST_OPTS), 3500);

  // Fast paths first: news_feed (headlines) + macro_indicators (macro calendar).
  // tradfi_news stays behind SIGNAL_TRY_EVENTS=1 (or last resort when opted in).
  const attempts = [
    {
      tool: 'news_feed',
      args: { action: 'headlines', symbol: sym, query: sym, limit: 5 },
      timeoutMs: 4000,
    },
    {
      tool: 'macro_indicators',
      args: { action: 'calendar', lookback_days: 3, lookahead_days: 5, limit: 8 },
      timeoutMs: 4000,
    },
  ];
  if (tryTradfi) {
    attempts.push({
      tool: 'tradfi_news',
      args: { action: 'earnings', symbol: sym, limit: 2 },
      timeoutMs: 7000,
    });
  }

  let anyHardFail = false;
  let lastError = null;
  let lastTool = null;
  let sawOkEmpty = false;

  for (const a of attempts) {
    const out = await callTool(a.tool, a.args, { timeoutMs: a.timeoutMs, retries: 0 });
    lastTool = a.tool;
    if (!out.ok) {
      anyHardFail = true;
      lastError = out.error;
      // timeout / unreachable → keep trying siblings; remember failure
      continue;
    }
    const payload = parsePayload(out.result);
    if (payload?.error) {
      anyHardFail = true;
      lastError = String(payload.error);
      continue;
    }
    const hit = classifyEventDetailed(payload, sym);
    if (hit && hit.value && hit.value !== 'none') {
      return {
        ok: true,
        value: hit.value,
        tag: 'observed',
        source: SOURCE,
        tool: a.tool,
        checked_window: checkedWindow,
        evidence: hit.evidence || undefined,
        note: hit.note || `Dated ${hit.value} item matched via ${a.tool}.`,
      };
    }
    sawOkEmpty = true;
  }

  if (!tryTradfi && !sawOkEmpty && anyHardFail) {
    // Fast paths failed and we did not opt into tradfi_news
    return failed(lastError || 'news_feed/macro_indicators unavailable', lastTool);
  }
  if (!tryTradfi && !sawOkEmpty && !anyHardFail) {
    // No attempts produced ok payloads and none hard-failed oddly — treat as skip-ish
    return assumedSkip('fast event tools unavailable; set SIGNAL_TRY_EVENTS=1 to also try tradfi_news');
  }
  if (sawOkEmpty) {
    return unverified(lastTool, lastError ? `Last error: ${lastError}` : '');
  }
  if (anyHardFail) {
    return failed(lastError || 'event tools failed', lastTool);
  }
  // Opted into tradfi but everything empty/failed already handled above
  return unverified(lastTool);
}

async function probeReachable() {
  toolsFailed = false;
  failCount = 0;
  cachedTools = null;
  client.reset();
  return client.probeReachable();
}

function deriveFromOpenLast(row) {
  if (!row || typeof row !== 'object') return null;
  const last = Number(row.last ?? row.last_price ?? row.price ?? row.close);
  const open = Number(row.open ?? row.open_price ?? row.prev_close ?? row.previous_close);
  if (Number.isFinite(last) && Number.isFinite(open) && open > 0) {
    return (last - open) / open;
  }
  return null;
}

function extractReturn(
  result,
  preferKeys = [
    'change_pct',
    'change24h',
    'pctChange',
    'return24h',
    'btcReturn',
    'usd_24h_change',
    'price_change_percentage_24h',
    'changePercent',
    'change_percent',
    'regularMarketChangePercent',
  ]
) {
  if (result == null) return null;
  const bag = typeof result === 'object' ? result : {};
  const flat = flatten(bag);
  for (const k of preferKeys) {
    for (const [fk, v] of Object.entries(flat)) {
      if (fk === k || fk.endsWith('.' + k) || fk.toLowerCase().includes(String(k).toLowerCase())) {
        const n = Number(v);
        if (Number.isFinite(n)) return normaliseReturn(n, fk);
      }
    }
  }
  for (const [k, v] of Object.entries(flat)) {
    if (/24h|change|return|pct/i.test(k) && Number.isFinite(Number(v))) {
      return normaliseReturn(Number(v), k);
    }
  }
  const closes = findCloses(result);
  if (closes && closes.length >= 2) {
    const a = closes[closes.length - 2];
    const b = closes[closes.length - 1];
    if (a > 0 && Number.isFinite(b)) return (b - a) / a;
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  const m = String(text).match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) return Number(m[1]) / 100;
  return null;
}

function findCloses(result) {
  const flat = flatten(typeof result === 'object' ? result : {});
  for (const [k, v] of Object.entries(flat)) {
    if (/close/i.test(k) && Array.isArray(v) && v.length >= 2) {
      return v.map(Number).filter(Number.isFinite);
    }
  }
  if (Array.isArray(result)) {
    const closes = result.map((row) => Number(row?.close ?? row?.[4])).filter(Number.isFinite);
    if (closes.length >= 2) return closes;
  }
  if (Array.isArray(result?.data)) {
    const closes = result.data.map((row) => Number(row?.close ?? row?.[4])).filter(Number.isFinite);
    if (closes.length >= 2) return closes;
  }
  return null;
}

function normaliseReturn(n, key = '') {
  // Signal crypto_derivatives change_pct is percent units even when |n| < 1
  // (e.g. -0.55 means -0.55%, not -55%).
  if (key && /pct|percent|percentage/i.test(String(key))) return n / 100;
  if (Math.abs(n) > 1) return n / 100;
  return n;
}


function classifyEventDetailed(result, symbol) {
  const sym = String(symbol || '').toUpperCase();
  const symLower = sym.toLowerCase();
  const items = extractEventItems(result);
  const now = Date.now();
  const windowMs = 7 * 24 * 3600 * 1000; // ±7d for "dated" match

  for (const it of items) {
    const text = String(it.text || '').toLowerCase();
    const dated = it.ts != null && Number.isFinite(it.ts);
    const inWindow = dated && Math.abs(now - it.ts) <= windowMs;
    if (!dated || !inWindow) continue;

    let value = null;
    if (new RegExp(`${symLower}.*earn|earn.*${symLower}|earnings|eps`).test(text) && text.includes(symLower)) {
      value = 'earnings';
    } else if (/cpi|fomc|fed\s*decision|payroll|nfp|inflation\s*print|pce/.test(text)) {
      value = 'cpi_fomc';
    } else if (/geopolit|war|sanction|conflict|missile|invasion/.test(text)) {
      value = 'geopolitics';
    }
    if (!value) continue;
    return {
      value,
      evidence: {
        title: it.title || it.text.slice(0, 120),
        date: it.date || (it.ts ? new Date(it.ts).toISOString().slice(0, 10) : null),
        symbol: sym,
      },
      note: `Matched dated ${value} item within ±7d.`,
    };
  }
  return { value: 'none' };
}

function extractEventItems(result) {
  const out = [];
  const bag = result == null ? [] : Array.isArray(result) ? result : [result];
  const queue = [...bag];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const title = cur.title || cur.headline || cur.name || cur.event || cur.summary;
    const dateRaw = cur.date || cur.datetime || cur.time || cur.published_at || cur.publishedAt || cur.ts || cur.timestamp;
    let ts = null;
    if (dateRaw != null) {
      const n = Number(dateRaw);
      if (Number.isFinite(n) && n > 1e11) ts = n;
      else if (Number.isFinite(n) && n > 1e9) ts = n * 1000;
      else {
        const d = Date.parse(String(dateRaw));
        if (Number.isFinite(d)) ts = d;
      }
    }
    const text = [title, cur.description, cur.body, cur.category, cur.type, JSON.stringify(cur)].filter(Boolean).join(' ');
    if (title || ts) {
      out.push({ title: title ? String(title) : '', text, ts, date: dateRaw != null ? String(dateRaw) : null });
    }
    for (const v of Object.values(cur)) {
      if (Array.isArray(v)) queue.push(...v);
      else if (v && typeof v === 'object') queue.push(v);
    }
  }
  // Fallback: whole payload as one undated blob (will not count as observed)
  if (!out.length && result != null) {
    out.push({ title: '', text: JSON.stringify(result), ts: null, date: null });
  }
  return out;
}

function classifyEvent(result, symbol) {
  const hit = classifyEventDetailed(result, symbol);
  return hit && hit.value ? hit.value : 'none';
}

function flatten(obj, prefix = '', out = {}) {
  if (obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function withSoftTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

module.exports = {
  MCP_URL,
  listTools,
  callTool,
  fetchBtc24hReturn,
  fetchNasdaqLastSession,
  fetchEventClass,
  probeReachable,
};
