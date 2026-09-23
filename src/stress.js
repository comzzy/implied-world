/**
 * F5 — Preset shocks + pure client-side recompute helpers.
 * Sliders must NOT call Qwen.
 */

const { K, STRESS_PAD_DEFAULT, EVENT_IMPORTANCE, solve } = require('./solver');

const PRESET_SHOCKS = [
  { id: 'event_to_zero', label: 'event → 0', apply: (f) => ({ ...f, eventImportance: 0, eventClass: { ...(f.eventClass || {}), value: 'none' } }) },
  { id: 'wrapper_plus_1_5', label: 'wrapper +1.5%', apply: (f) => bumpPremium(f, 0.015) },
  { id: 'btc_residual_minus_3', label: 'BTC residual −3%', apply: (f) => ({
    ...f,
    btc24hReturn: { ...(f.btc24hReturn || {}), value: (Number(f.btc24hReturn?.value) || 0) - 0.03 },
  }) },
];

function bumpPremium(freeze, delta) {
  const cur = Number(freeze.premium?.value) || 0;
  return {
    ...freeze,
    premium: { ...(freeze.premium || {}), value: cur + delta },
  };
}

function runStressTable(freeze, baseBand) {
  const rows = PRESET_SHOCKS.map((shock) => {
    const shocked = shock.apply(structuredCloneSafe(freeze));
    // Preserve eventImportance override when event→0
    if (shock.id === 'event_to_zero') shocked.eventImportance = 0;
    const band = solve(shocked, { stressPad: baseBand?.stress_pad ?? STRESS_PAD_DEFAULT });
    return {
      id: shock.id,
      label: shock.label,
      status: band.status,
      mid: band.implied_gap_mid,
      lo: band.implied_gap_lo,
      hi: band.implied_gap_hi,
      dies: band.status === 'NO_ROOM' || band.status === 'OPEN_BUT_UNSTABLE',
    };
  });

  const first = rows.find((r) => r.dies) || null;
  return {
    rows,
    firstToDie: first ? { id: first.id, label: first.label, status: first.status } : null,
  };
}

/**
 * Pure recompute from frozen JSON + slider knobs.
 * Used by API (slider_endpoints) and mirrored in public/app.js.
 */
function recomputeFromSliders(freeze, knobs = {}) {
  const eventImportance = clamp(
    knobs.eventImportance != null ? Number(knobs.eventImportance) : (freeze.eventImportance ?? 0.1),
    0,
    1
  );
  const wrapperBump = Number(knobs.wrapperBumpPct != null ? knobs.wrapperBumpPct : 0) / 100;
  const btcResidual = Number(
    knobs.btcResidualPct != null
      ? knobs.btcResidualPct / 100
      : freeze.btc24hReturn?.value ?? 0
  );
  const stressPad = Number(knobs.stressPad != null ? knobs.stressPad : STRESS_PAD_DEFAULT);

  const f = structuredCloneSafe(freeze);
  f.eventImportance = eventImportance;
  const basePrem = Number(freeze.premium?.value) || 0;
  f.premium = { ...(f.premium || {}), value: basePrem + wrapperBump };
  f.btc24hReturn = { ...(f.btc24hReturn || {}), value: btcResidual };

  const band = solve(f, { stressPad });
  const stress = runStressTable(f, band);
  return { band, stress, knobs: { eventImportance, wrapperBumpPct: wrapperBump * 100, btcResidualPct: btcResidual * 100, stressPad } };
}

function sliderEndpoints(freeze) {
  return {
    eventImportance: { min: 0, max: 1, step: 0.05, default: freeze.eventImportance ?? EVENT_IMPORTANCE[freeze.eventClass?.value] ?? 0.1 },
    wrapperBumpPct: { min: 0, max: 3, step: 0.1, default: 0 },
    btcResidualPct: { min: -5, max: 5, step: 0.1, default: round1((Number(freeze.btc24hReturn?.value) || 0) * 100) },
    note: 'Client-side only. Does not call Qwen or place orders.',
  };
}

function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = {
  PRESET_SHOCKS,
  runStressTable,
  recomputeFromSliders,
  sliderEndpoints,
  K,
  STRESS_PAD_DEFAULT,
};
