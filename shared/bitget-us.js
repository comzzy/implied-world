/**
 * Bitget US MCP HTTP helper.
 * Endpoint: https://agent.bitget.com/mcp
 *
 * Catalog tools: guide + do_query.
 * Cash: equity_price_quote
 * rToken / wrapper: crypto_futures_ticker (NVDAUSDT etc.) + crypto_coin_info fallback
 * Book: crypto_futures_order_book when available
 * Never invent silent "live" quotes. Failures tagged source_failed / assumed.
 */

const { createMcpClient } = require('./mcp-http');

const MCP_URL = 'https://agent.bitget.com/mcp';
const SOURCE = 'bitget-us';

const client = createMcpClient(MCP_URL, SOURCE, {
  timeoutMs: 12000,
  retries: 1,
  backoffMs: 500,
});

let cachedTools = null;
let toolsFailed = false;
let catalogCache = null;

async function listTools() {
  if (toolsFailed) return { ok: false, error: 'cached unreachable', source: SOURCE, unreachable: true };
  if (cachedTools) return cachedTools;
  const out = await client.listTools({ retries: 1 });
  if (out.ok) cachedTools = out;
  else toolsFailed = true;
  return out;
}

async function callTool(name, args = {}, callOpts = {}) {
  if (toolsFailed) return { ok: false, error: 'mcp unreachable (fail-fast)', source: SOURCE };
  return client.callTool(name, args, { retries: 1, ...callOpts });
}

function parseToolPayload(result) {
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

function summarise(result) {
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return s.length > 500 ? s.slice(0, 500) + '…' : s;
}

function unwrapResults(payload) {
  if (!payload) return null;
  if (payload.success === false) return null;
  const data = payload.data !== undefined ? payload.data : payload;
  if (data == null || data === '') return null;
  if (Array.isArray(data.results)) return data.results;
  if (data.results != null && typeof data.results === 'object') return [data.results];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object' && (data.last != null || data.last_price != null || data.price != null || data.current_price != null)) {
    return [data];
  }
  return null;
}

function extractPrice(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    row.last,
    row.last_price,
    row.close,
    row.price,
    row.current_price,
    row.mark_price,
    row.index_price,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Discover catalog entries via guide (category / keyword).
 * Used to locate rToken / wrapper / order-book entry_ids.
 */
async function discoverCatalog(opts = {}) {
  await listTools();
  if (toolsFailed) {
    return { ok: false, error: 'mcp unreachable', tag: 'source_failed', source: SOURCE };
  }

  const keywords = opts.keywords || [
    'rtoken',
    'rToken',
    'stock token',
    'wrapper',
    'NVDAUSDT',
    'tokenized',
    'equity',
    'order_book',
    'depth',
  ];
  const categories = opts.categories || ['equity', 'crypto'];
  const entries = [];
  const seen = new Set();

  // Top-level categories
  const top = await callTool('guide', {});
  const topPayload = parseToolPayload(top.result);

  for (const cat of categories) {
    const g = await callTool('guide', { category: cat });
    if (!g.ok) continue;
    const payload = parseToolPayload(g.result);
    const list = payload?.entries || [];
    for (const e of list) {
      if (!e?.id || seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push({
        id: e.id,
        title: e.title,
        summary: e.summary,
        subcategory: e.subcategory,
        category: cat,
        params: e.params_summary || [],
      });
    }
  }

  // Keyword probes (guide often ignores keyword and returns categories; still try)
  const keywordHits = [];
  for (const kw of keywords) {
    const g = await callTool('guide', { keyword: kw });
    if (!g.ok) continue;
    const payload = parseToolPayload(g.result);
    if (Array.isArray(payload?.entries)) {
      for (const e of payload.entries) {
        if (e?.id && !seen.has(e.id)) {
          seen.add(e.id);
          entries.push({ id: e.id, title: e.title, summary: e.summary, keyword: kw });
        }
        if (e?.id) keywordHits.push({ keyword: kw, id: e.id });
      }
    }
  }

  const rtokenRelated = entries.filter((e) =>
    /rwa|stock|token|wrapper|futures|ticker|order_book|coin_info|market/i.test(
      `${e.id} ${e.title || ''} ${e.summary || ''}`
    )
  );

  catalogCache = {
    ok: true,
    tag: 'observed',
    source: SOURCE,
    categories: topPayload?.categories || categories,
    entries,
    rtokenRelated,
    keywordHits,
    hasRtokenTicker: entries.some((e) => e.id === 'crypto_futures_ticker'),
    hasOrderBook: entries.some((e) => e.id === 'crypto_futures_order_book'),
    hasCoinInfo: entries.some((e) => e.id === 'crypto_coin_info'),
    hasRwaMarket: entries.some((e) => e.id === 'crypto_market'),
    note:
      'Closest Bitget wrapper for US names is crypto_futures_ticker on {SYM}USDT (RWA stock perpetuals). No literal "rToken" entry_id in guide.',
  };
  return catalogCache;
}

async function getCatalogSummary() {
  if (catalogCache) return catalogCache;
  return discoverCatalog();
}

/**
 * Live equity (cash) quote via equity_price_quote.
 */
async function fetchQuote(symbol) {
  const sym = String(symbol || '').toUpperCase();
  await listTools();
  if (toolsFailed) {
    return { ok: false, symbol: sym, error: 'mcp unreachable', tag: 'source_failed', source: SOURCE };
  }

  const out = await callTool('do_query', {
    entry_id: 'equity_price_quote',
    params: { symbol: sym },
  });
  if (!out.ok) {
    return { ok: false, symbol: sym, error: out.error, tag: 'source_failed', source: SOURCE };
  }

  const payload = parseToolPayload(out.result);
  if (payload?.success === false) {
    return {
      ok: false,
      symbol: sym,
      error: payload.error || 'query failed',
      tag: 'source_failed',
      source: SOURCE,
    };
  }

  const rows = unwrapResults(payload);
  const row = rows?.[0];
  const price = extractPrice(row);
  const prevClose = Number(row?.prev_close ?? row?.previous_close ?? row?.prevClose);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ok: false,
      symbol: sym,
      error: 'no price in equity_price_quote',
      tag: 'source_failed',
      source: SOURCE,
      raw: summarise(payload),
    };
  }

  return {
    ok: true,
    symbol: sym,
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    tag: 'observed',
    source: SOURCE,
    tool: 'do_query:equity_price_quote',
    kind: 'cash_equity',
    raw: summarise(row),
  };
}

/**
 * True wrapper / rToken-adjacent quote — separate from cash equity.
 * Prefer Bitget RWA stock perpetual (crypto_futures_ticker SYMUSDT),
 * then crypto_coin_info tokenized stock, then fail soft (caller may assume).
 */
async function fetchRtokenQuote(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const pair = `${sym}USDT`;
  await listTools();
  if (toolsFailed) {
    return { ok: false, symbol: sym, error: 'mcp unreachable', tag: 'source_failed', source: SOURCE };
  }

  const attempts = [
    {
      entry_id: 'crypto_futures_ticker',
      params: { symbol: pair, exchange: 'bitget' },
      label: 'bitget RWA perpetual',
    },
    {
      entry_id: 'crypto_futures_ticker',
      params: { symbol: pair },
      label: 'futures ticker (default venue)',
    },
    {
      entry_id: 'crypto_coin_info',
      params: { symbol: sym },
      label: 'tokenized stock coin_info',
    },
  ];

  const errors = [];
  for (const a of attempts) {
    const out = await callTool('do_query', { entry_id: a.entry_id, params: a.params });
    if (!out.ok) {
      errors.push(`${a.entry_id}: ${out.error}`);
      continue;
    }
    const payload = parseToolPayload(out.result);
    if (payload?.success === false || payload?.status_code === 400) {
      errors.push(`${a.entry_id}: ${JSON.stringify(payload?.data || payload?.error || 'fail').slice(0, 120)}`);
      continue;
    }
    const rows = unwrapResults(payload);
    if (!rows || !rows.length) {
      errors.push(`${a.entry_id}: empty`);
      continue;
    }

    // Prefer rows that look like tokenized / RWA / matching base
    let row = rows.find((r) => /tokenized|robinhood|rwa|derivatives/i.test(String(r.name || r.id || '')))
      || rows.find((r) => String(r.symbol || '').toUpperCase().includes(sym))
      || rows[0];

    const price = extractPrice(row);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(`${a.entry_id}: no price`);
      continue;
    }

    const bid = Number(row.bid ?? row.bidPrice);
    const ask = Number(row.ask ?? row.askPrice);
    return {
      ok: true,
      symbol: sym,
      pair,
      price,
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      exchange: row.exchange || a.params.exchange || null,
      instrument: row.symbol || pair,
      tag: 'observed',
      source: SOURCE,
      tool: `do_query:${a.entry_id}`,
      kind: 'wrapper_rtoken',
      note: `Observed wrapper via ${a.label} (${a.entry_id}). Not a literal "rToken" catalog id — closest traded stock perpetual / tokenized print.`,
      raw: summarise(row),
    };
  }

  return {
    ok: false,
    symbol: sym,
    pair,
    error: errors.slice(0, 4).join(' | ') || 'no wrapper quote',
    tag: 'source_failed',
    source: SOURCE,
    kind: 'wrapper_rtoken',
  };
}

/**
 * Futures order book for thin-wrapper check.
 */
async function fetchOrderBook(symbol, limit = 20) {
  const sym = String(symbol || '').toUpperCase();
  const pair = `${sym}USDT`;
  await listTools();
  if (toolsFailed) {
    return { ok: false, symbol: sym, error: 'mcp unreachable', tag: 'source_failed', source: SOURCE };
  }

  const attempts = [
    { entry_id: 'crypto_futures_order_book', params: { symbol: pair, exchange: 'bitget', limit } },
    { entry_id: 'crypto_futures_order_book', params: { symbol: pair, limit } },
  ];

  const errors = [];
  for (const a of attempts) {
    const out = await callTool('do_query', { entry_id: a.entry_id, params: a.params });
    if (!out.ok) {
      errors.push(`${a.entry_id}: ${out.error}`);
      continue;
    }
    const payload = parseToolPayload(out.result);
    if (payload?.success === false) {
      errors.push(`${a.entry_id}: query failed`);
      continue;
    }
    const rows = unwrapResults(payload);
    const book = rows?.[0] || payload?.data?.results || payload?.data;
    const bids = book?.bids || book?.bid || [];
    const asks = book?.asks || book?.ask || [];
    if (!Array.isArray(bids) || !Array.isArray(asks) || !bids.length || !asks.length) {
      errors.push(`${a.entry_id}: empty book`);
      continue;
    }

    const bestBid = Number(Array.isArray(bids[0]) ? bids[0][0] : bids[0]?.price);
    const bestAsk = Number(Array.isArray(asks[0]) ? asks[0][0] : asks[0]?.price);
    const bidQty = Number(Array.isArray(bids[0]) ? bids[0][1] : bids[0]?.qty ?? bids[0]?.size);
    const askQty = Number(Array.isArray(asks[0]) ? asks[0][1] : asks[0]?.qty ?? asks[0]?.size);

    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
      errors.push(`${a.entry_id}: bad bid/ask`);
      continue;
    }

    const mid = (bestBid + bestAsk) / 2;
    const spread = (bestAsk - bestBid) / mid;
    let depthNotional = 0;
    const levels = Math.min(5, bids.length, asks.length);
    for (let i = 0; i < levels; i++) {
      const bPx = Number(Array.isArray(bids[i]) ? bids[i][0] : bids[i]?.price);
      const bQty = Number(Array.isArray(bids[i]) ? bids[i][1] : bids[i]?.qty ?? bids[i]?.size);
      const aPx = Number(Array.isArray(asks[i]) ? asks[i][0] : asks[i]?.price);
      const aQty = Number(Array.isArray(asks[i]) ? asks[i][1] : asks[i]?.qty ?? asks[i]?.size);
      if (Number.isFinite(bPx) && Number.isFinite(bQty)) depthNotional += bPx * bQty;
      if (Number.isFinite(aPx) && Number.isFinite(aQty)) depthNotional += aPx * aQty;
    }

    return {
      ok: true,
      symbol: sym,
      pair,
      bestBid,
      bestAsk,
      bidQty: Number.isFinite(bidQty) ? bidQty : null,
      askQty: Number.isFinite(askQty) ? askQty : null,
      spread,
      depthNotional,
      mid,
      tag: 'observed',
      source: SOURCE,
      tool: `do_query:${a.entry_id}`,
      raw: summarise({ bestBid, bestAsk, spread, depthNotional, levels }),
    };
  }

  return {
    ok: false,
    symbol: sym,
    error: errors.slice(0, 3).join(' | ') || 'order book unavailable',
    tag: 'source_failed',
    source: SOURCE,
  };
}

async function fetchProfile(symbol) {
  const sym = String(symbol || '').toUpperCase();
  await listTools();
  if (toolsFailed) {
    return { ok: false, symbol: sym, error: 'mcp unreachable', tag: 'source_failed', source: SOURCE };
  }
  const out = await callTool('do_query', {
    entry_id: 'equity_profile',
    params: { symbol: sym },
  });
  if (!out.ok) {
    return { ok: false, symbol: sym, error: out.error, tag: 'source_failed', source: SOURCE };
  }
  return {
    ok: true,
    symbol: sym,
    profile: summarise(parseToolPayload(out.result)),
    tag: 'observed',
    source: SOURCE,
    tool: 'do_query:equity_profile',
  };
}

/**
 * Prefer prev_close from quote as last cash close.
 */
async function fetchKlines(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const quote = await fetchQuote(sym);
  if (quote.ok && quote.prevClose != null) {
    return {
      ok: true,
      symbol: sym,
      lastClose: quote.prevClose,
      lastPrice: quote.price,
      tag: 'observed',
      source: SOURCE,
      tool: 'do_query:equity_price_quote#prev_close',
      raw: quote.raw,
    };
  }
  if (quote.ok && quote.price != null) {
    return {
      ok: true,
      symbol: sym,
      lastClose: quote.price,
      lastPrice: quote.price,
      tag: 'assumed',
      source: SOURCE,
      note: 'Using last_price as cash close proxy; prev_close missing.',
      tool: 'do_query:equity_price_quote#last_price',
    };
  }
  return {
    ok: false,
    symbol: sym,
    error: quote.error || 'klines unavailable',
    tag: 'source_failed',
    source: SOURCE,
  };
}

async function probeReachable() {
  toolsFailed = false;
  cachedTools = null;
  catalogCache = null;
  return client.probeReachable();
}

function assumedPlaceholder(symbol, kind = 'cash') {
  return {
    ok: false,
    symbol: String(symbol).toUpperCase(),
    price: null,
    tag: 'assumed',
    source: SOURCE,
    source_failed: true,
    note: `MCP unavailable; no live ${kind} quote. Desk continues with tagged assumptions.`,
  };
}

module.exports = {
  MCP_URL,
  listTools,
  callTool,
  fetchQuote,
  fetchRtokenQuote,
  fetchOrderBook,
  fetchProfile,
  fetchKlines,
  discoverCatalog,
  getCatalogSummary,
  probeReachable,
  assumedPlaceholder,
};
