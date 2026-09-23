/**
 * F6 — Opposite implied world from the same freeze.
 * Invert residual / event framing. Still no buy/sell.
 */

const { solve, STRESS_PAD_DEFAULT, EVENT_IMPORTANCE } = require('./solver');
const { channelSplit } = require('./channels');
const { decayBands } = require('./decay');

function twinWorld(freeze, primaryBand) {
  const f = JSON.parse(JSON.stringify(freeze));
  const residual = Number(f.btc24hReturn?.value) || 0;
  f.btc24hReturn = {
    ...(f.btc24hReturn || {}),
    value: -residual,
    note: 'Twin inverts BTC residual sign for counter-framing.',
  };

  const cls = f.eventClass?.value || 'none';
  // Counter-framing: dial event importance toward the complement
  const ei = f.eventImportance != null ? Number(f.eventImportance) : (EVENT_IMPORTANCE[cls] ?? 0.1);
  f.eventImportance = clamp(1 - ei, 0, 1);
  f.twin = true;

  const band = solve(f, { stressPad: primaryBand?.stress_pad ?? STRESS_PAD_DEFAULT });
  const channels = channelSplit(f, band);
  const decay = decayBands(f, primaryBand?.stress_pad ?? STRESS_PAD_DEFAULT);

  return {
    label: 'COUNTER-THESIS',
    framing: 'Inverted residual and complementary event importance on the same freeze.',
    freeze_delta: {
      residual_btc: f.btc24hReturn.value,
      event_importance: f.eventImportance,
    },
    band,
    channels,
    decay: {
      band_now: decay.band_now,
      band_if_friday_night: decay.band_if_friday_night,
    },
  };
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

module.exports = { twinWorld };
