/**
 * Implied World — Express API + static desk UI.
 * Human decides. This desk does not trade.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const { hasKey, chat } = require('../shared/qwen');
const { sanitizeObject, sanitizeText } = require('../shared/sanitize');
const { classifyFailure, failurePayload } = require('../shared/failures');
const bitgetUs = require('../shared/bitget-us');
const bitgetSignal = require('../shared/bitget-signal');
const { listSymbols, getSymbol } = require('../shared/rtoken');
const { freezeInputs } = require('./freeze');
const { solve, K, STRESS_PAD_DEFAULT } = require('./solver');
const { decayBands } = require('./decay');
const { channelSplit } = require('./channels');
const { sizeStress } = require('./size-stress');
const { runStressTable, sliderEndpoints, recomputeFromSliders } = require('./stress');
const { twinWorld } = require('./twin');
const { factorCheck } = require('./factor');
const { buildReceipt } = require('./receipt');
const { runLattice } = require('./lattice');
const { draftKillCriteria, evaluateBoard } = require('./kill-criteria');
const { runAtlas, SHOCK_TYPES } = require('./atlas');

const app = express();
const PORT = Number(process.env.PORT) || 3847;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', async (_req, res) => {
  const [us, signal] = await Promise.all([
    bitgetUs.probeReachable(),
    bitgetSignal.probeReachable(),
  ]);
  res.json({
    ok: true,
    service: 'implied-world',
    qwen_key_present: hasKey(),
    mcp: {
      'bitget-us': us,
      'bitget-signal': signal,
    },
    symbols: listSymbols(),
    constants: { k: K, stress_pad_default: STRESS_PAD_DEFAULT },
    banner: 'Human decides. This desk does not trade.',
  });
});

app.get('/api/sample-freeze', (_req, res) => {
  res.status(410).json({
    ok: false,
    failureKind: 'missing_data',
    failureMessage:
      'Sample freezes are retired. Run the Desk first, then load that live freeze on Lattice / Kill Board / Atlas.',
    error:
      'Sample freezes are retired. Run the Desk first, then load that live freeze on Lattice / Kill Board / Atlas.',
    banner: 'Human decides. This desk does not trade.',
  });
});

app.post('/api/recompute', (req, res) => {
  try {
    const { freeze, knobs } = req.body || {};
    if (!freeze) return res.status(400).json({ ok: false, error: 'freeze required' });
    const out = recomputeFromSliders(freeze, knobs || {});
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ...failurePayload(err, { kind: 'api', status: 400 }), ok: false });
  }
});

app.post('/api/lattice', (req, res) => {
  try {
    const body = req.body || {};
    const freeze = body.freeze;
    if (!freeze) {
      return res.status(400).json({
        ...failurePayload(
          new Error('Run the Desk first, then load that live freeze here.'),
          { kind: 'missing_data', status: 400 }
        ),
        ok: false,
      });
    }
    const cashOpens = normalizePctArray(body.cashOpens, [-3, -2, -1, 0, 1, 2, 3], true);
    const residualShocks = normalizePctArray(body.residualShocks, [-3, 0, 3], true);
    const wrapperBumps = body.wrapperBumps != null
      ? normalizePctArray(body.wrapperBumps, [0], true)
      : [0];

    const out = runLattice(freeze, {
      cashOpens,
      residualShocks,
      wrapperBumps,
      stressPad: body.stressPad,
    });
    res.json(sanitizeObject({
      ok: true,
      symbol: freeze.symbol,
      fromSample: false,
      ...out,
      banner: 'Human decides. This desk does not trade.',
    }));
  } catch (err) {
    const kind = err.failureKind || 'api';
    res.status(400).json({ ...failurePayload(err, { kind, status: 400 }), ok: false });
  }
});

app.post('/api/kill-board', (req, res) => {
  try {
    const body = req.body || {};
    const freeze = body.freeze;
    if (!freeze) {
      return res.status(400).json({
        ...failurePayload(
          new Error('Run the Desk first, then load that live freeze here.'),
          { kind: 'missing_data', status: 400 }
        ),
        ok: false,
      });
    }
    const band = body.band || solve(freeze);
    let criteria = Array.isArray(body.criteria) && body.criteria.length
      ? body.criteria
      : draftKillCriteria(freeze, band);

    // Sanitize any user-edited plain text
    criteria = criteria.map((c) => ({
      ...c,
      label: sanitizeText(String(c.label || '')),
      plain: sanitizeText(String(c.plain || '')),
      locked: Boolean(c.locked),
    }));

    const evaluated = evaluateBoard(criteria, freeze, band);
    res.json(sanitizeObject({
      ok: true,
      symbol: freeze.symbol,
      fromSample: false,
      criteria: evaluated,
      band: {
        status: band.status,
        mid: band.implied_gap_mid,
        lo: band.implied_gap_lo,
        hi: band.implied_gap_hi,
        premium: band.premium,
      },
      banner: 'Human decides. This desk does not trade.',
    }));
  } catch (err) {
    const kind = err.failureKind || 'api';
    res.status(400).json({ ...failurePayload(err, { kind, status: 400 }), ok: false });
  }
});

app.post('/api/atlas', async (req, res) => {
  try {
    const body = req.body || {};
    const sourceSymbol = String(body.sourceSymbol || body.symbol || 'NVDA').toUpperCase();
    const shockType = String(body.shockType || 'btc_residual_minus_3');
    if (!SHOCK_TYPES[shockType]) {
      return res.status(400).json({
        ok: false,
        error: `Unknown shockType. Use: ${Object.keys(SHOCK_TYPES).join(', ')}`,
      });
    }

    let freezes = body.freezes && typeof body.freezes === 'object' ? { ...body.freezes } : null;

    // Require a desk freeze for the focus symbol; live-freeze peers. Never sample.
    if (!freezes) {
      if (!body.freeze || !body.freeze.symbol) {
        return res.status(400).json({
          ...failurePayload(
            new Error('Run the Desk first, then load that live freeze here.'),
            { kind: 'missing_data', status: 400 }
          ),
          ok: false,
        });
      }
      freezes = {};
      freezes[String(body.freeze.symbol).toUpperCase()] = body.freeze;
    }

    const focusKey = String(body.freeze?.symbol || sourceSymbol).toUpperCase();
    if (!freezes[focusKey] && body.freeze) {
      freezes[focusKey] = body.freeze;
    }
    if (!freezes[sourceSymbol] && freezes[focusKey]) {
      // Allow focus freeze under sourceSymbol if caller set source to match
      if (focusKey === sourceSymbol) freezes[sourceSymbol] = freezes[focusKey];
    }
    if (!freezes[sourceSymbol]) {
      return res.status(400).json({
        ...failurePayload(
          new Error(
            'Atlas needs a live desk freeze for ' +
              sourceSymbol +
              '. Run the Desk for that name, then load the freeze here.'
          ),
          { kind: 'missing_data', status: 400 }
        ),
        ok: false,
      });
    }

    // Live-freeze peers; mark source_failed on error — never invent numbers.
    await Promise.all(
      ['NVDA', 'TSLA', 'AAPL'].map(async (sym) => {
        if (freezes[sym]) return;
        try {
          freezes[sym] = await freezeInputs(sym, { style: 'weekend_swing' });
          const cashOk = freezes[sym]?.cashClose?.value != null;
          const rtOk = freezes[sym]?.rtoken?.value != null;
          const premOk = freezes[sym]?.premium?.value != null;
          if (!premOk && (!cashOk || !rtOk)) {
            freezes[sym] = {
              symbol: sym,
              _failed: true,
              source_failed: true,
              _failNote: 'Live peer freeze missing cash or rToken — no sample substituted.',
            };
          }
        } catch (err) {
          freezes[sym] = {
            symbol: sym,
            _failed: true,
            source_failed: true,
            _failNote: String(err.message || 'Live peer freeze failed'),
          };
        }
      })
    );

    const out = runAtlas({
      freezes,
      sourceSymbol,
      shockType,
    });
    res.json(sanitizeObject({
      ok: true,
      ...out,
      fromSample: false,
      useSample: false,
      shockTypes: Object.values(SHOCK_TYPES).map((s) => ({
        id: s.id,
        label: s.label,
        plain: s.plain,
        kind: s.kind,
      })),
      banner: 'Human decides. This desk does not trade.',
    }));
  } catch (err) {
    const kind = err.failureKind || 'api';
    const status = kind === 'missing_data' ? 400 : 400;
    res.status(status).json({ ...failurePayload(err, { kind, status }), ok: false });
  }
});

app.post('/api/implied-world', async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || 'NVDA').toUpperCase();
  const thesis = sanitizeText(String(body.thesis || ''));
  const style = String(body.style || 'weekend_swing');
  const notionalUsdt = Number(body.notionalUsdt) || 5000;

  if (!getSymbol(symbol)) {
    return res.status(400).json({
      ...failurePayload(new Error(`Unsupported symbol. Use one of: ${listSymbols().join(', ')}`), { kind: 'api', status: 400 }),
    });
  }

  try {
    const t0 = Date.now();
    // Leave headroom under Vercel function maxDuration (60s on this project).
    const budgetMs = process.env.VERCEL
      ? Number(process.env.VERCEL_DESK_BUDGET_MS) || 52000
      : Number(process.env.DESK_BUDGET_MS) || 180000;

    // 1. Freeze Bitget inputs
    const freeze = await freezeInputs(symbol, {
      thesis,
      style,
      thinWrapper: body.thinWrapper,
    });

    // Core legs must be live — never publish invented mid prices.
    const cashMissing = freeze.cashClose?.value == null;
    const rtokenMissing = freeze.rtoken?.value == null;

    if (cashMissing || rtokenMissing) {
      const parts = [];
      if (cashMissing) parts.push('cash close');
      if (rtokenMissing) parts.push('rToken');
      return res.status(422).json({
        ...failurePayload(
          new Error(
            'Live ' +
              parts.join(' and ') +
              ' unavailable for ' +
              symbol +
              '. Desk will not invent mid prices. Try again when feeds answer.'
          ),
          { kind: 'missing_data', status: 422 }
        ),
        freeze,
        sources: freeze.sources,
      });
    }

    // 2. Solve + stresses + twin + factor + receipt (no Qwen)
    const band0 = solve(freeze);
    const decay = decayBands(freeze, band0.stress_pad);

    // Prefer decay-adjusted "now" band for status display
    const band = {
      ...band0,
      implied_gap_lo: decay.band_now.lo,
      implied_gap_mid: decay.band_now.mid,
      implied_gap_hi: decay.band_now.hi,
      status: decay.band_now.status,
      stress_pad: decay.band_now.pad,
    };

    const channels = channelSplit(freeze, band);
    const size = sizeStress(freeze, band, notionalUsdt);
    const stress = runStressTable(freeze, band);
    const twin = twinWorld(freeze, band);
    // Attach channels to twin for UI stack
    if (twin && !twin.channels) {
      twin.channels = channelSplit(freeze, twin.band || band);
    }
    const factor = factorCheck(symbol, freeze);
    const receipt = buildReceipt({ freeze, band, twin, factor, size, stress });
    const sliders = sliderEndpoints(freeze);

    let briefing = null;
    let briefing_error = null;

    // 3. Research briefing if key present — never block numeric desk.
    // On Vercel, only spend leftover budget so the response returns before a 504.
    if (hasKey()) {
      const elapsed = Date.now() - t0;
      const remaining = budgetMs - elapsed;
      const envCap = Number(process.env.QWEN_TIMEOUT_MS) || (process.env.VERCEL ? 22000 : 50000);
      const qwenMs = Math.max(0, Math.min(envCap, remaining - 2500));
      if (qwenMs < 6000) {
        briefing = null;
        briefing_error =
          'Research briefing skipped to finish within the platform time limit; numeric desk is intact.';
        console.log('Qwen briefing skipped; remaining_ms', remaining);
      } else {
        try {
          console.log('Qwen briefing start budget_ms', qwenMs);
          const _qt0 = Date.now();
          briefing = await askQwenBriefing({
            freeze,
            band,
            channels,
            size,
            stress,
            twin,
            factor,
            receipt,
            thesis,
            style,
            timeoutMs: qwenMs,
          });
          briefing = sanitizeObject(briefing);
          console.log('Qwen briefing ok', Date.now() - _qt0, 'ms');
        } catch (err) {
          briefing = null;
          briefing_error = err.message;
          console.log('Qwen briefing fail', err.message);
        }
      }
    } else {
      briefing_error = 'BITGET_QWEN_API_KEY not set; numeric desk returned without writeup.';
    }

    const payload = sanitizeObject({
      ok: true,
      banner: 'Human decides. This desk does not trade.',
      symbol,
      thesis,
      style,
      notionalUsdt,
      freeze,
      band,
      decay,
      status: band.status,
      channels,
      size,
      stress,
      slider_endpoints: sliders,
      twin,
      factor,
      lamp: receipt.lamp,
      receipt: {
        lamp: receipt.lamp,
        reasons: receipt.reasons,
        copyable: receipt.copyable,
        emit_hint: receipt.emit_hint,
      },
      briefing,
      briefing_error,
      ...(briefing_error
        ? {
            failureKind: 'writeup',
            failureMessage:
              'Writeup failed — numbers are still OK. ' + String(briefing_error).slice(0, 160),
          }
        : {}),
      sources: freeze.sources,
      constants: { k: K, stress_pad_default: STRESS_PAD_DEFAULT },
    });

    res.json(payload);
  } catch (err) {
    const kind = err.failureKind || 'server';
    const status = kind === 'missing_data' ? 422 : 500;
    res.status(status).json(failurePayload(err, { kind, status }));
  }
});

/**
 * Accept arrays of percents (1 = 1%) or decimals (0.01). Heuristic: |x| > 0.2 → treat as percent.
 */
function normalizePctArray(arr, fallbackPct, asDecimal) {
  const src = Array.isArray(arr) && arr.length ? arr : fallbackPct;
  return src.map((x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    if (asDecimal) {
      // If value looks like a percent magnitude (> 0.2), convert
      if (Math.abs(n) > 0.2) return n / 100;
      return n;
    }
    return n;
  });
}

async function askQwenBriefing(ctx) {
  const f = ctx.freeze || {};
  const hours = f.hoursToCashOpen || f.hoursToOpen || {};
  // Compact frozen table only — not the entire response blob.
  const compact = {
    symbol: f.symbol,
    cash: numTag(f.cashClose),
    rtoken: numTag(f.rtoken),
    premium: numTag(f.premium),
    residual_btc: numTag(f.btc24hReturn),
    event: f.eventClass
      ? { value: f.eventClass.value, tag: f.eventClass.tag }
      : null,
    hours: hours.hours != null ? { value: hours.hours, tag: hours.tag || 'computed' } : null,
    band: {
      status: ctx.band?.status,
      lo: ctx.band?.implied_gap_lo,
      mid: ctx.band?.implied_gap_mid,
      hi: ctx.band?.implied_gap_hi,
    },
    firstToDie: ctx.size?.first_to_die || ctx.size?.firstToDie || null,
    factor: ctx.factor?.verdict || null,
    lamp: ctx.receipt?.lamp || null,
  };

  const timeoutMs = Number(ctx.timeoutMs) || Number(process.env.QWEN_TIMEOUT_MS) || (process.env.VERCEL ? 22000 : 50000);
  const system =
    'Writer for Implied World. ' +
    'Output JSON only with keys: evidence, implied_world, stress, considerations, invalidation. ' +
    'Total 4–6 short sentences across all keys. ' +
    'Use ONLY numbers in the frozen table. ' +
    'If a field tag is assumed or source_failed, say so. ' +
    'No BUY/SELL/LONG/SHORT. No hype. No fillers. No invented prices.';

  const user = 'Frozen table:\n' + JSON.stringify(compact);

  const raw = await Promise.race([
    chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      json: true,
      timeoutMs,
      maxTokens: Number(process.env.QWEN_MAX_TOKENS) || 420,
      temperature: 0.15,
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Qwen briefing timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);

  function pick(obj) {
    return {
      evidence: sanitizeText(String(obj.evidence || '')),
      implied_world: sanitizeText(String(obj.implied_world || obj.impliedWorld || '')),
      stress: sanitizeText(String(obj.stress || '')),
      considerations: sanitizeText(String(obj.considerations || '')),
      invalidation: sanitizeText(String(obj.invalidation || '')),
    };
  }

  if (typeof raw === 'string') {
    try {
      return pick(JSON.parse(raw));
    } catch {
      return {
        evidence: sanitizeText(raw.slice(0, 800)),
        implied_world: '',
        stress: '',
        considerations: '',
        invalidation: '',
      };
    }
  }
  return pick(raw || {});
}

function numTag(field) {
  if (!field || typeof field !== 'object') return null;
  return {
    value: field.value,
    tag: field.tag,
  };
}

module.exports = app;

if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    // Never log secrets
    console.log(`Implied World desk on http://127.0.0.1:${PORT}`);
    console.log(`Qwen key present: ${hasKey()}`);
    console.log('Human decides. This desk does not trade.');
  });
}
