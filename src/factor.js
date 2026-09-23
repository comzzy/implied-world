/**
 * F7 — Same-hour premium cross-check across NVDA / TSLA / AAPL.
 * NAME | FACTOR_NOT_NAME
 */

const { listSymbols } = require('../shared/rtoken');

/**
 * @param {string} focusSymbol
 * @param {object} freeze - primary freeze (has peerPremiums map if available)
 */
function factorCheck(focusSymbol, freeze) {
  const focus = String(focusSymbol || '').toUpperCase();
  const peers = freeze.peerPremiums || {};
  const focusPrem = Number(freeze.premium?.value);
  const rows = [];

  for (const sym of listSymbols()) {
    let prem = null;
    let tag = 'source_failed';
    if (sym === focus && Number.isFinite(focusPrem)) {
      prem = focusPrem;
      tag = freeze.premium?.tag || 'observed';
    } else if (peers[sym] && Number.isFinite(Number(peers[sym].value))) {
      prem = Number(peers[sym].value);
      tag = peers[sym].tag || 'assumed';
    }
    rows.push({ symbol: sym, premium: prem, tag, is_focus: sym === focus });
  }

  const known = rows.filter((r) => r.premium != null);
  let verdict = 'NAME';
  let note = 'Insufficient peer premiums to compare.';

  if (known.length >= 2 && Number.isFinite(focusPrem)) {
    const others = known.filter((r) => r.symbol !== focus);
    if (others.length) {
      const avgOther = others.reduce((s, r) => s + r.premium, 0) / others.length;
      const dispersion = Math.abs(focusPrem - avgOther);
      // If focus moves with the pack (within 40 bps of peer average), call FACTOR_NOT_NAME
      if (dispersion < 0.004) {
        verdict = 'FACTOR_NOT_NAME';
        note = `Focus premium (${pct(focusPrem)}) tracks peer average (${pct(avgOther)}) — factor-like.`;
      } else {
        verdict = 'NAME';
        note = `Focus premium (${pct(focusPrem)}) diverges from peer average (${pct(avgOther)}) — name-like.`;
      }
    }
  }

  return {
    focus: focus,
    verdict,
    note,
    rows,
  };
}

function pct(x) {
  return `${(Number(x) * 100).toFixed(2)}%`;
}

module.exports = { factorCheck };
