/**
 * F1 — Implied gap band solver.
 * Never encodes buy/sell direction.
 */

const K = 0.4;
const STRESS_PAD_DEFAULT = 0.008; // 0.8%

const EVENT_IMPORTANCE = {
  none: 0.1,
  geopolitics: 0.45,
  cpi_fomc: 0.7,
  earnings: 0.85,
};

/**
 * @param {object} freeze
 * @param {{ stressPad?: number }} [opts]
 */
function solve(freeze, opts = {}) {
  const k = K;
  const stressPad = opts.stressPad != null ? Number(opts.stressPad) : STRESS_PAD_DEFAULT;
  const premium = num(freeze.premium?.value, 0);
  const residualBtc = num(freeze.btc24hReturn?.value, 0);
  const eventClass = freeze.eventClass?.value || 'none';
  const eventImportance =
    freeze.eventImportance != null
      ? clamp(Number(freeze.eventImportance), 0, 1)
      : EVENT_IMPORTANCE[eventClass] ?? 0.1;

  const implied_gap_mid = premium + k * eventImportance * residualBtc;
  const implied_gap_lo = implied_gap_mid - stressPad;
  const implied_gap_hi = implied_gap_mid + stressPad;

  const thin = Boolean(freeze.thinWrapper?.value);
  const livePremium = premium;
  const realEvent = eventClass !== 'none';

  let status = 'ROOM_LEFT';
  if (livePremium >= implied_gap_hi) {
    status = 'NO_ROOM';
  } else if (
    livePremium < implied_gap_lo - stressPad &&
    realEvent &&
    thin
  ) {
    status = 'OPEN_BUT_UNSTABLE';
  } else if (livePremium < implied_gap_lo && realEvent && thin) {
    status = 'OPEN_BUT_UNSTABLE';
  }

  return {
    k,
    stress_pad: stressPad,
    event_importance: eventImportance,
    event_class: eventClass,
    residual_btc: residualBtc,
    premium: livePremium,
    implied_gap_mid,
    implied_gap_lo,
    implied_gap_hi,
    status,
    constants: { k: K, stress_pad_default: STRESS_PAD_DEFAULT },
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

module.exports = {
  K,
  STRESS_PAD_DEFAULT,
  EVENT_IMPORTANCE,
  solve,
};
