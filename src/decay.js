/**
 * F2 — Time decay of the stress pad as hours-to-cash-open fall.
 * pad *= clamp(hours/48, 0.25, 1)
 */

const { solve, STRESS_PAD_DEFAULT } = require('./solver');

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function decayPad(basePad, hoursToOpen) {
  const h = Number(hoursToOpen);
  if (!Number.isFinite(h)) return { pad: basePad, factor: 1, hours: null };
  const factor = clamp(h / 48, 0.25, 1);
  return { pad: basePad * factor, factor, hours: h };
}

/**
 * Return band_now vs band_if_friday_night for the same freeze.
 */
function decayBands(freeze, basePad = STRESS_PAD_DEFAULT) {
  const hours = freeze.hoursToOpen?.hours;
  const now = decayPad(basePad, hours);
  const bandNow = solve(freeze, { stressPad: now.pad });

  // Friday night ≈ ~63 hours to Monday 09:30 ET (rough desk constant)
  const fridayNightHours = 63;
  const fri = decayPad(basePad, fridayNightHours);
  const bandFriday = solve(freeze, { stressPad: fri.pad });

  return {
    base_pad: basePad,
    band_now: {
      hours_to_open: now.hours,
      pad: now.pad,
      factor: now.factor,
      lo: bandNow.implied_gap_lo,
      mid: bandNow.implied_gap_mid,
      hi: bandNow.implied_gap_hi,
      status: bandNow.status,
    },
    band_if_friday_night: {
      hours_to_open: fridayNightHours,
      pad: fri.pad,
      factor: fri.factor,
      lo: bandFriday.implied_gap_lo,
      mid: bandFriday.implied_gap_mid,
      hi: bandFriday.implied_gap_hi,
      status: bandFriday.status,
    },
    outline: buildOutline(freeze, basePad),
  };
}

/** Sample pad/band across hour marks for a simple chart. */
function buildOutline(freeze, basePad) {
  const points = [];
  for (const h of [0, 6, 12, 24, 36, 48, 63, 72]) {
    const d = decayPad(basePad, h);
    const s = solve(freeze, { stressPad: d.pad });
    points.push({
      hours: h,
      pad: d.pad,
      lo: s.implied_gap_lo,
      mid: s.implied_gap_mid,
      hi: s.implied_gap_hi,
    });
  }
  return points;
}

module.exports = { decayPad, decayBands, buildOutline };
