/**
 * Contagion Atlas — coupled multi-name heat map.
 * Shared residual/event shocks hit all names; wrapper shocks hit only the source name.
 * Live freezes only — never substitutes sample / demo numbers.
 */

const { solve } = require('./solver');
const { sanitizeText } = require('../shared/sanitize');

const PLAIN = {
  ROOM_LEFT: 'Room left',
  NO_ROOM: 'No room',
  OPEN_BUT_UNSTABLE: 'Unstable',
};

const SYMBOLS = ['NVDA', 'TSLA', 'AAPL'];

const SHOCK_TYPES = {
  wrapper_plus_1_5: {
    id: 'wrapper_plus_1_5',
    label: 'Wrapper +1.5%',
    plain: 'Raise only the source name’s wrapper premium by 1.5%. Others stay at baseline.',
    kind: 'wrapper',
    wrapperDelta: 0.015,
  },
  btc_residual_minus_3: {
    id: 'btc_residual_minus_3',
    label: 'BTC move (not from the stock) −3%',
    plain: 'Push BTC residual down 3 points on every name (shared).',
    kind: 'factor',
    residualDelta: -0.03,
  },
  event_to_zero: {
    id: 'event_to_zero',
    label: 'Remove the calendar event',
    plain: 'Clear the calendar event on every name (shared).',
    kind: 'factor',
    eventToZero: true,
  },
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function applyShock(freeze, shock, { isSource } = {}) {
  const f = clone(freeze);
  const def = typeof shock === 'string' ? SHOCK_TYPES[shock] : shock;
  if (!def) return f;

  if (def.kind === 'wrapper' || def.wrapperDelta != null) {
    if (isSource) {
      const cur = num(f.premium?.value, 0);
      f.premium = { ...(f.premium || {}), value: cur + num(def.wrapperDelta, 0.015) };
    }
    return f;
  }

  if (def.residualDelta != null) {
    const cur = num(f.btc24hReturn?.value, 0);
    f.btc24hReturn = { ...(f.btc24hReturn || {}), value: cur + num(def.residualDelta) };
  }
  if (def.eventToZero) {
    f.eventImportance = 0;
    f.eventClass = { ...(f.eventClass || {}), value: 'none' };
  }
  return f;
}

function freezeUsable(f) {
  if (!f || typeof f !== 'object') return false;
  if (f._failed || f.source_failed) return false;
  const cash = f.cashClose?.value;
  const rt = f.rtoken?.value;
  const prem = f.premium?.value;
  // Need premium path or both legs; null cash/rtoken with no premium → unusable
  if (prem != null && Number.isFinite(Number(prem))) return true;
  return (
    cash != null &&
    Number.isFinite(Number(cash)) &&
    rt != null &&
    Number.isFinite(Number(rt))
  );
}

/**
 * @param {object} [opts]
 * @param {object} [opts.freezes] map symbol → freeze (may include _failed entries)
 * @param {string} [opts.sourceSymbol]
 * @param {string} [opts.shockType]
 */
function runAtlas(opts = {}) {
  const sourceSymbol = String(opts.sourceSymbol || 'NVDA').toUpperCase();
  const shockType = String(opts.shockType || 'btc_residual_minus_3');
  const shockDef = SHOCK_TYPES[shockType] || SHOCK_TYPES.btc_residual_minus_3;

  const freezes = opts.freezes && typeof opts.freezes === 'object' ? opts.freezes : null;
  if (!freezes) {
    const err = new Error(
      'Run the Desk first, then load that live freeze here. Atlas needs a desk freeze for the focus symbol.'
    );
    err.failureKind = 'missing_data';
    throw err;
  }

  if (!freezeUsable(freezes[sourceSymbol])) {
    const err = new Error(
      'Focus symbol ' +
        sourceSymbol +
        ' has no usable live freeze. Run the Desk for that name, then load the freeze here.'
    );
    err.failureKind = 'missing_data';
    throw err;
  }

  const baseline = {};
  const shocked = {};
  const failedSymbols = [];

  for (const sym of SYMBOLS) {
    const f = freezes[sym];
    if (!freezeUsable(f)) {
      failedSymbols.push(sym);
      baseline[sym] = {
        status: 'SOURCE_FAILED',
        plain: 'Failed',
        mid: null,
        lo: null,
        hi: null,
        premium: null,
        failed: true,
        source_failed: true,
      };
      shocked[sym] = {
        status: 'SOURCE_FAILED',
        plain: 'Failed',
        mid: null,
        lo: null,
        hi: null,
        premium: null,
        flipped: false,
        is_source: sym === sourceSymbol,
        failed: true,
        source_failed: true,
        note: sanitizeText(
          (f && (f._failNote || f.note)) ||
            'Live freeze failed for this name — no sample substituted.'
        ),
      };
      continue;
    }

    const baseBand = solve(f);
    baseline[sym] = {
      status: baseBand.status,
      plain: PLAIN[baseBand.status],
      mid: baseBand.implied_gap_mid,
      lo: baseBand.implied_gap_lo,
      hi: baseBand.implied_gap_hi,
      premium: baseBand.premium,
    };

    const fShock = applyShock(f, shockDef, { isSource: sym === sourceSymbol });
    const band = solve(fShock);
    const flippedStatus = band.status !== baseBand.status;

    shocked[sym] = {
      status: band.status,
      plain: PLAIN[band.status],
      mid: band.implied_gap_mid,
      lo: band.implied_gap_lo,
      hi: band.implied_gap_hi,
      premium: band.premium,
      flipped: flippedStatus,
      is_source: sym === sourceSymbol,
    };
  }

  const flipCount = SYMBOLS.filter(
    (s) => shocked[s] && shocked[s].flipped && !shocked[s].failed
  ).length;
  let breakKind = 'none';
  let breakPlain = 'No name changed status under this shock.';
  if (flipCount === 1) {
    breakKind = 'single_name';
    breakPlain = sanitizeText(
      'Single-name break: only one name flipped status. The stress looks name-specific, not a shared factor break.'
    );
  } else if (flipCount >= 2) {
    breakKind = 'factor';
    breakPlain = sanitizeText(
      'Factor break: two or more names flipped status together. The stress is acting like a shared factor across the desk.'
    );
  }

  return {
    sourceSymbol,
    shock: {
      id: shockDef.id,
      label: shockDef.label,
      plain: sanitizeText(shockDef.plain),
      kind: shockDef.kind,
    },
    symbols: SYMBOLS,
    baseline,
    cells: shocked,
    flipCount,
    breakKind,
    breakPlain,
    fromSample: false,
    failedSymbols,
    plain_map: PLAIN,
    note: sanitizeText('Human decides. This atlas does not place orders.'),
  };
}

module.exports = {
  runAtlas,
  applyShock,
  SHOCK_TYPES,
  PLAIN,
  SYMBOLS,
};
