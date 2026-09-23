/**
 * F8 — Lamp ALIGNED | CONTESTED + copyable receipt.
 */

function buildReceipt({ freeze, band, twin, factor, size, stress }) {
  const primaryStatus = band?.status || 'ROOM_LEFT';
  const twinStatus = twin?.band?.status || null;
  const factorVerdict = factor?.verdict || 'NAME';

  let lamp = 'ALIGNED';
  const reasons = [];

  if (primaryStatus === 'NO_ROOM') {
    lamp = 'CONTESTED';
    reasons.push('Primary band status NO_ROOM — live premium already at or above implied_gap_hi.');
  }
  if (primaryStatus === 'OPEN_BUT_UNSTABLE') {
    lamp = 'CONTESTED';
    reasons.push('Primary band OPEN_BUT_UNSTABLE — thin wrapper + real event + premium far below band.');
  }
  if (twinStatus && twinStatus !== primaryStatus) {
    lamp = 'CONTESTED';
    reasons.push(`Twin status ${twinStatus} disagrees with primary ${primaryStatus}.`);
  }
  if (factorVerdict === 'FACTOR_NOT_NAME' && primaryStatus === 'ROOM_LEFT') {
    reasons.push('Factor check says FACTOR_NOT_NAME — premium may be pack-driven.');
  }
  if (size && size.band_survives === false) {
    lamp = 'CONTESTED';
    reasons.push(`Size eats room (${size.size_eats_room_bps} bps) — band does not survive impact.`);
  }
  if (stress?.firstToDie) {
    reasons.push(`First-to-die shock: ${stress.firstToDie.label} → ${stress.firstToDie.status}.`);
  }
  if (!reasons.length) {
    reasons.push('Primary band, twin, size, and factor checks do not contradict within desk thresholds.');
  }

  const shouldEmitCopy =
    primaryStatus === 'NO_ROOM' ||
    (twinStatus && twinStatus !== primaryStatus) ||
    lamp === 'CONTESTED';

  const lines = [
    'IMPLIED WORLD RECEIPT',
    `symbol: ${freeze.symbol}`,
    `as_of: ${freeze.asOf}`,
    `premium: ${fmtPct(band.premium)} (tag=${freeze.premium?.tag || '?'})`,
    `band: lo=${fmtPct(band.implied_gap_lo)} mid=${fmtPct(band.implied_gap_mid)} hi=${fmtPct(band.implied_gap_hi)}`,
    `status: ${primaryStatus}`,
    `lamp: ${lamp}`,
    `factor: ${factorVerdict}`,
    twinStatus ? `twin_status: ${twinStatus}` : null,
    size ? `size_eats_room_bps: ${size.size_eats_room_bps}; survives=${size.band_survives}` : null,
    stress?.firstToDie ? `first_to_die: ${stress.firstToDie.label}` : null,
    `hours_to_open: ${freeze.hoursToOpen?.hours != null ? freeze.hoursToOpen.hours.toFixed(2) : 'n/a'}`,
    `k=${band.k}; stress_pad=${band.stress_pad}`,
    'Human decides. This desk does not trade.',
    ...reasons.map((r) => `note: ${r}`),
  ].filter(Boolean);

  return {
    lamp,
    reasons,
    copyable: shouldEmitCopy ? lines.join('\n') : lines.join('\n'),
    emit_hint: shouldEmitCopy ? 'NO_ROOM_or_flip' : 'informational',
  };
}

function fmtPct(x) {
  if (!Number.isFinite(Number(x))) return 'n/a';
  return `${(Number(x) * 100).toFixed(3)}%`;
}

module.exports = { buildReceipt };
