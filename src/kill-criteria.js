/**
 * Kill Board — draft measurable falsification criteria from freeze + band.
 * No buy/sell language. Human locks criteria before Monday.
 */

const { solve } = require('./solver');
const { sanitizeText } = require('../shared/sanitize');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pctLabel(x, d = 2) {
  return (num(x) * 100).toFixed(d) + '%';
}

/**
 * Draft 4–5 measurable kill criteria from freeze + optional band.
 * @param {object} freeze
 * @param {object} [band]
 */
function draftKillCriteria(freeze, band) {
  if (!freeze) throw new Error('freeze required');
  const b = band || solve(freeze);
  const prem = num(freeze.premium?.value, 0);
  const hi = num(b.implied_gap_hi, prem + 0.008);
  const lo = num(b.implied_gap_lo, prem - 0.008);
  const mid = num(b.implied_gap_mid, prem);
  const residual = num(freeze.btc24hReturn?.value, 0);
  const residualFloor = residual - 0.03;
  const eventClass = freeze.eventClass?.value || 'none';
  const thin = Boolean(freeze.thinWrapper?.value);
  const eventLive = eventClass !== 'none';

  const criteria = [
    {
      id: 'premium_at_band_high',
      label: 'Wrapper premium at or above band high',
      plain: sanitizeText(
        `If the wrapper premium sits at or above ${pctLabel(hi)} (the top of the leftover room range), the overnight idea has no room left.`
      ),
      check: {
        type: 'premium_gte',
        threshold: hi,
        field: 'premium',
      },
    },
    {
      id: 'btc_residual_floor',
      label: 'BTC move (not from the stock) through floor while event live',
      plain: sanitizeText(
        eventLive
          ? `If BTC residual drops through ${pctLabel(residualFloor)} while the calendar event (${eventClass}) is still live, treat as falsified.`
          : `If BTC residual drops through ${pctLabel(residualFloor)} (about 3 points below the freeze), treat the residual channel as broken.`
      ),
      check: {
        type: 'residual_lte',
        threshold: residualFloor,
        require_event: eventLive,
        field: 'btc24hReturn',
      },
    },
    {
      id: 'size_eats_room',
      label: 'Size eats the leftover room',
      plain: sanitizeText(
        `If a larger notional would push the effective premium past range middle (${pctLabel(mid)}), size has already eaten the room — shrink or stand down.`
      ),
      check: {
        type: 'status_is',
        statuses: ['NO_ROOM'],
        note: 'Fires when current solve status is No room (often size/premium pressure).',
      },
    },
    {
      id: 'thin_book_plus_event',
      label: 'Not enough buyers/sellers with a live event',
      plain: sanitizeText(
        thin && eventLive
          ? `Thin book in the wrapper plus a live ${eventClass} event is already an unstable setup — lock this as a kill if books stay thin into Monday.`
          : `If the wrapper does not have enough buyers and sellers while any calendar event is live, mark the setup unstable and step away.`
      ),
      check: {
        type: 'thin_and_event',
        field: 'thinWrapper',
      },
    },
    {
      id: 'unstable_status',
      label: 'Desk reads unstable',
      plain: sanitizeText(
        `If the desk status flips to Unstable (premium under the range low with a thin book and a real event), the idea is already proven wrong before the open.`
      ),
      check: {
        type: 'status_is',
        statuses: ['OPEN_BUT_UNSTABLE'],
      },
    },
  ];

  return criteria.map((c) => ({
    ...c,
    plain: sanitizeText(c.plain),
    label: sanitizeText(c.label),
  }));
}

/**
 * Evaluate one criterion against current freeze (+ optional solved band).
 * Returns traffic: GREEN | AMBER | RED
 */
function evaluateCriterion(criterion, freeze, band) {
  const b = band || solve(freeze);
  const check = criterion?.check || {};
  const prem = num(freeze.premium?.value, 0);
  const residual = num(freeze.btc24hReturn?.value, 0);
  const thin = Boolean(freeze.thinWrapper?.value);
  const eventLive = (freeze.eventClass?.value || 'none') !== 'none';

  switch (check.type) {
    case 'premium_gte': {
      const th = num(check.threshold);
      if (prem >= th) return 'RED';
      if (prem >= th - 0.002) return 'AMBER';
      return 'GREEN';
    }
    case 'residual_lte': {
      const th = num(check.threshold);
      const needEvent = Boolean(check.require_event);
      if (residual <= th && (!needEvent || eventLive)) return 'RED';
      if (residual <= th + 0.01) return 'AMBER';
      return 'GREEN';
    }
    case 'thin_and_event': {
      if (thin && eventLive) return 'RED';
      if (thin || eventLive) return 'AMBER';
      return 'GREEN';
    }
    case 'status_is': {
      const list = check.statuses || [];
      if (list.includes(b.status)) return 'RED';
      if (b.status === 'OPEN_BUT_UNSTABLE' && list.includes('NO_ROOM')) return 'AMBER';
      return 'GREEN';
    }
    default:
      return 'AMBER';
  }
}

/**
 * Evaluate all criteria; merge optional user edits (plain, locked).
 */
function evaluateBoard(criteria, freeze, band) {
  const b = band || solve(freeze);
  return (criteria || []).map((c) => {
    const light = evaluateCriterion(c, freeze, b);
    return {
      id: c.id,
      label: sanitizeText(c.label || ''),
      plain: sanitizeText(c.plain || ''),
      locked: Boolean(c.locked),
      check: c.check,
      light,
      light_plain: light === 'GREEN' ? 'Clear' : light === 'AMBER' ? 'Watch' : 'Firing',
    };
  });
}

module.exports = {
  draftKillCriteria,
  evaluateCriterion,
  evaluateBoard,
};
