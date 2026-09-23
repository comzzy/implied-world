/**
 * F4 — Size eats room: notional impact vs band width.
 */

function sizeStress(freeze, band, notionalUsdt) {
  const notional = Math.max(0, Number(notionalUsdt) || 0);
  const spreadBps = estimateSpreadBps(freeze);
  const depthUsdt = estimateDepthUsdt(freeze);

  // Impact bps ≈ spread/2 + notional/depth * 10bps heuristic
  const halfSpread = spreadBps / 2;
  const depthImpact = depthUsdt > 0 ? (notional / depthUsdt) * 10 : 25;
  const size_eats_room_bps = round2(halfSpread + depthImpact);

  const bandWidth = Math.abs((band.implied_gap_hi ?? 0) - (band.implied_gap_lo ?? 0));
  const bandWidthBps = bandWidth * 10000;
  const roomAfter = bandWidthBps - size_eats_room_bps;
  const bandSurvives = roomAfter > 0;

  return {
    notional_usdt: notional,
    spread_bps_est: spreadBps,
    depth_usdt_est: depthUsdt,
    size_eats_room_bps,
    band_width_bps: round2(bandWidthBps),
    room_after_impact_bps: round2(roomAfter),
    band_survives: bandSurvives,
    tags: {
      spread: freeze.bookSpread?.tag || 'assumed',
      depth: freeze.bookDepth?.tag || 'assumed',
    },
  };
}

function estimateSpreadBps(freeze) {
  if (freeze.bookSpread?.value != null && Number.isFinite(Number(freeze.bookSpread.value))) {
    // value as decimal spread → bps
    return round2(Number(freeze.bookSpread.value) * 10000);
  }
  // Thin wrapper default ~12 bps; normal ~6 bps
  return freeze.thinWrapper?.value ? 12 : 6;
}

function estimateDepthUsdt(freeze) {
  if (freeze.bookDepth?.value != null && Number.isFinite(Number(freeze.bookDepth.value))) {
    return Number(freeze.bookDepth.value);
  }
  return freeze.thinWrapper?.value ? 8000 : 40000;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { sizeStress };
