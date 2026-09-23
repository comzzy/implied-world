/**
 * F3 — Split rToken move into name / btc_residual / wrapper stacks.
 * Labels only — percentages sum ~100.
 */

function channelSplit(freeze, band) {
  const premium = abs(band?.premium ?? freeze.premium?.value ?? 0);
  const residual = abs(band?.residual_btc ?? freeze.btc24hReturn?.value ?? 0);
  const k = band?.k ?? 0.4;
  const ei = band?.event_importance ?? 0.1;

  // Attribution magnitudes (desk heuristic, not a trade signal)
  const nameMag = premium * 0.55;
  const btcMag = abs(k * ei * residual);
  const wrapperMag = premium * 0.45 + 0.001; // thin wrapper residual + epsilon

  const total = nameMag + btcMag + wrapperMag || 1;
  let name = (nameMag / total) * 100;
  let btc_residual = (btcMag / total) * 100;
  let wrapper = (wrapperMag / total) * 100;

  // Renormalise to 100 with 1dp
  const sum = name + btc_residual + wrapper;
  name = round1((name / sum) * 100);
  btc_residual = round1((btc_residual / sum) * 100);
  wrapper = round1(100 - name - btc_residual);

  return {
    name_pct: name,
    btc_residual_pct: btc_residual,
    wrapper_pct: wrapper,
    labels: ['name', 'btc_residual', 'wrapper'],
    note: 'Attribution stack for the observed premium vs residual — labels only, not a side.',
  };
}

function abs(n) {
  return Math.abs(Number(n) || 0);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { channelSplit };
