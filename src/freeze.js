/**
 * Freeze Bitget-tagged inputs for one symbol.
 * Tags: observed | assumed | targeted | source_failed
 */

const bitgetUs = require('../shared/bitget-us');
const bitgetSignal = require('../shared/bitget-signal');
const {
  getSymbol,
  premium,
  hoursToNextUsCashOpen,
  listSymbols,
} = require('../shared/rtoken');
const { EVENT_IMPORTANCE } = require('./solver');


function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

async function freezeInputs(symbol, opts = {}) {
  const sym = String(symbol || 'NVDA').toUpperCase();
  const meta = getSymbol(sym);
  if (!meta) {
    throw new Error(`Unsupported symbol ${sym}. Use NVDA, TSLA, or AAPL.`);
  }

  const sources = [];
  const asOf = new Date().toISOString();

  const [usProbe, signalProbe] = await Promise.all([
    bitgetUs.probeReachable(),
    bitgetSignal.probeReachable(),
  ]);
  sources.push(tagSource('mcp_bitget_us', usProbe));
  sources.push(tagSource('mcp_bitget_signal', signalProbe));

  let cashK;
  let cashQuote;
  let rQuote;
  let book;
  let btc;
  let nasdaq;
  let event;

  if (usProbe.ok) {
    [cashK, cashQuote, rQuote, book] = await Promise.all([
      bitgetUs.fetchKlines(sym, '1d', 3),
      bitgetUs.fetchQuote(sym),
      bitgetUs.fetchRtokenQuote(sym),
      bitgetUs.fetchOrderBook(sym, 20),
    ]);
  } else {
    const fail = { ok: false, tag: 'source_failed', error: usProbe.detail, source: 'bitget-us' };
    cashK = { ...fail };
    cashQuote = { ...fail };
    rQuote = { ...fail };
    book = { ...fail };
  }

  // Per-call timeouts (not one shared budget that kills all).
  // BTC path has Bitget US + CoinGecko fallbacks inside fetchBtc24hReturn.
  // Nasdaq prefers Bitget US QQQ when Signal hangs. Event may stay assumed none.
  {
    const btcMs = Number(process.env.SIGNAL_BTC_TIMEOUT_MS) || 12000;
    const nasdaqMs = Number(process.env.SIGNAL_NASDAQ_TIMEOUT_MS) || 12000;
    const eventMs = Number(process.env.SIGNAL_EVENT_TIMEOUT_MS) || 8000;
    const fail = (label, ms, source) => ({
      ok: false,
      value: label === 'event' ? 'none' : null,
      tag: 'source_failed',
      source: source || 'bitget-signal',
      error: `per-call timeout ${ms}ms`,
      note:
        label === 'event'
          ? 'Event feed timed out. event_class=none. No event was verified (source_failed). Not inventing earnings.'
          : undefined,
    });

    // Always attempt fetchers — they own their own fallbacks even if probe failed.
    [btc, nasdaq, event] = await Promise.all([
      withTimeout(bitgetSignal.fetchBtc24hReturn(), btcMs, fail('btc', btcMs)),
      withTimeout(bitgetSignal.fetchNasdaqLastSession(), nasdaqMs, fail('nasdaq', nasdaqMs)),
      withTimeout(bitgetSignal.fetchEventClass(sym), eventMs, fail('event', eventMs)),
    ]);
  }

  sources.push(tagSource('cash_klines', cashK));
  sources.push(tagSource('cash_quote', cashQuote));
  sources.push(tagSource('rtoken_quote', rQuote));
  sources.push(tagSource('rtoken_book', book));
  sources.push(tagSource('btc_24h', btc));
  sources.push(tagSource('nasdaq', nasdaq));
  sources.push(tagSource('event_class', event));

  let cashClose = {
    value:
      cashK.lastClose != null
        ? cashK.lastClose
        : cashQuote.prevClose != null
          ? cashQuote.prevClose
          : cashQuote.price != null
            ? cashQuote.price
            : null,
    tag: cashK.tag || cashQuote.tag || (cashK.ok || cashQuote.ok ? 'observed' : 'source_failed'),
    source: 'bitget-us',
    tool: cashK.tool || cashQuote.tool,
  };
  if (cashClose.value == null) {
    cashClose = {
      value: null,
      tag: 'source_failed',
      source: 'bitget-us',
      note: 'MCP cash close unavailable; no invented placeholder. Run when feeds answer.',
      error: cashK.error || cashQuote.error || 'cash close missing',
    };
  } else if (
    cashK.tag === 'assumed' ||
    (cashQuote.ok && cashClose.value === cashQuote.price && cashQuote.prevClose == null)
  ) {
    if (cashClose.tag === 'observed') cashClose.tag = 'assumed';
    cashClose.note = cashClose.note || 'Cash close using last print; prev_close missing.';
  }

  let rtoken = {
    value: rQuote.ok && rQuote.price != null ? rQuote.price : null,
    tag: rQuote.ok && rQuote.price != null ? 'observed' : rQuote.tag || 'source_failed',
    source: 'bitget-us',
    tool: rQuote.tool,
    instrument: rQuote.instrument || rQuote.pair || null,
    exchange: rQuote.exchange || null,
    note: rQuote.note,
  };
  if (rtoken.value == null) {
    rtoken = {
      value: null,
      tag: 'source_failed',
      source: 'bitget-us',
      tool: rQuote.tool,
      instrument: rQuote.instrument || rQuote.pair || null,
      exchange: rQuote.exchange || null,
      note:
        'MCP rToken quote unavailable; no equity or cash×premium proxy invented. ' +
        (rQuote.error || rQuote.note || ''),
      error: rQuote.error || 'rtoken quote missing',
    };
  }

  const prem = premium(rtoken.value, cashClose.value);
  const premiumField = {
    value: prem.ok ? prem.value : null,
    tag:
      cashClose.tag === 'observed' && rtoken.tag === 'observed'
        ? 'observed'
        : cashClose.tag === 'source_failed' || rtoken.tag === 'source_failed'
          ? 'source_failed'
          : 'assumed',
    source: 'derived',
    formula: '(rtoken - cash) / cash',
  };
  if (!prem.ok) {
    premiumField.tag = 'source_failed';
    premiumField.error = prem.error;
  }

  const hours = hoursToNextUsCashOpen(new Date());
  const hoursToOpen = {
    hours: hours.hours,
    nextOpenEt: hours.nextOpenEt,
    inSession: hours.inSession,
    tag: hours.tag || 'computed',
    note: hours.note,
  };
  // Always populate alias used by decay/UI copy.
  const hoursToCashOpen = { ...hoursToOpen };

  const btc24hReturn = {
    value: btc.value != null ? btc.value : 0,
    tag: btc.ok && btc.value != null ? (btc.tag || 'observed') : (btc.tag || 'assumed'),
    source: btc.source || 'bitget-signal',
    tool: btc.tool,
    note: btc.ok && btc.value != null
      ? btc.note
      : btc.note || btc.error || 'BTC residual unavailable; using 0 (assumed).',
  };
  if (!(btc.ok && btc.value != null)) {
    // Keep numeric residual path alive but never pretend observed.
    if (btc24hReturn.tag === 'observed') btc24hReturn.tag = 'assumed';
  }

  const nasdaqLast = {
    value: nasdaq.value,
    tag: nasdaq.tag || (nasdaq.ok ? 'observed' : 'source_failed'),
    source: nasdaq.source || 'bitget-signal',
    tool: nasdaq.tool,
    note: nasdaq.ok ? nasdaq.note : nasdaq.note || nasdaq.error,
  };

  const eventClass = {
    value: event.value || 'none',
    tag: event.tag || (event.ok ? 'observed' : 'assumed'),
    source: event.source || 'bitget-signal',
    tool: event.tool,
    note: event.note || event.error,
    checked_window: event.checked_window,
    evidence: event.evidence,
    error: event.error,
  };

  const eventImportance = EVENT_IMPORTANCE[eventClass.value] ?? 0.1;

  let thinWrapper;
  let bookSpread;
  let bookDepth;

  if (book && book.ok && Number.isFinite(book.spread)) {
    const spread = book.spread;
    const depth = Number(book.depthNotional ?? book.depthNotional);
    const thinBySpread = spread > 0.001;
    const thinByDepth = Number.isFinite(depth) && depth > 0 && depth < 25000;
    thinWrapper = {
      value: Boolean(opts.thinWrapper) || thinBySpread || thinByDepth,
      tag: 'observed',
      source: 'bitget-us',
      tool: book.tool,
      note: `From futures order book: spread=${(spread * 10000).toFixed(1)}bps, top5 notional≈${
        Number.isFinite(depth) ? depth.toFixed(0) : 'n/a'
      }.`,
    };
    bookSpread = {
      value: spread,
      tag: 'observed',
      source: 'bitget-us',
      tool: book.tool,
    };
    bookDepth = {
      value: Number.isFinite(depth) ? depth : null,
      tag: Number.isFinite(depth) ? 'observed' : 'source_failed',
      source: 'bitget-us',
      tool: book.tool,
    };
  } else {
    thinWrapper = {
      value:
        Boolean(opts.thinWrapper) ||
        (premiumField.value != null && Math.abs(premiumField.value) > 0.02),
      tag: 'assumed',
      source: 'heuristic',
      note:
        'Thin-wrapper flag from premium magnitude heuristic; order book unavailable. ' +
        (book && book.error ? book.error : ''),
    };
    bookSpread = {
      value: thinWrapper.value ? 0.0012 : 0.0006,
      tag: 'assumed',
      source: 'heuristic',
      note: 'Assumed spread; MCP book not available.',
    };
    bookDepth = {
      value: thinWrapper.value ? 8000 : 40000,
      tag: 'assumed',
      source: 'heuristic',
      note: 'Assumed depth; MCP book not available.',
    };
  }

  const peerPremiums = usProbe.ok
    ? await freezePeerPremiums(sym)
    : assumedPeerPremiums(sym, premiumField.value);

  return {
    symbol: sym,
    displayName: meta.displayName,
    asOf,
    cashClose,
    rtoken,
    premium: premiumField,
    hoursToOpen,
    hoursToCashOpen,
    btc24hReturn,
    nasdaqLast,
    eventClass,
    eventImportance,
    thinWrapper,
    bookSpread,
    bookDepth,
    peerPremiums,
    sources,
    style: opts.style || null,
    thesis: opts.thesis || null,
  };
}

function assumedPeerPremiums(focus, _focusPrem) {
  const out = {};
  for (const sym of listSymbols()) {
    if (sym === focus) continue;
    out[sym] = {
      value: null,
      tag: 'source_failed',
      note: 'Peer premium unavailable; MCP US unreachable — no invented peer premium.',
    };
  }
  return out;
}

async function freezePeerPremiums(focus) {
  const out = {};
  const peers = listSymbols().filter((s) => s !== focus);
  await Promise.all(
    peers.map(async (sym) => {
      try {
        const [k, q, r] = await Promise.all([
          bitgetUs.fetchKlines(sym, '1d', 2),
          bitgetUs.fetchQuote(sym),
          bitgetUs.fetchRtokenQuote(sym),
        ]);
        let cash = k.lastClose ?? q.prevClose ?? q.price;
        let rt = r.ok ? r.price : null;
        if (cash == null || rt == null) {
          out[sym] = {
            value: null,
            tag: 'source_failed',
            note: 'Peer cash or rToken missing; no invented placeholder.',
            rtoken_tool: r.tool,
          };
          return;
        }
        let tag = r.ok ? 'observed' : 'assumed';
        if (r.tag === 'assumed') tag = 'assumed';
        const p = premium(rt, cash);
        out[sym] = {
          value: p.ok ? p.value : null,
          tag: p.ok ? tag : 'source_failed',
          rtoken_tool: r.tool,
        };
      } catch {
        out[sym] = { value: null, tag: 'source_failed' };
      }
    })
  );
  return out;
}

function tagSource(name, result) {
  return {
    name,
    ok: Boolean(result?.ok),
    tag: result?.tag || (result?.ok ? 'observed' : 'source_failed'),
    source: result?.source,
    error: result?.error || result?.detail || undefined,
    tool: result?.tool || undefined,
  };
}

module.exports = { freezeInputs };
