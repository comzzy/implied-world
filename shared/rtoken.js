/**
 * US stock rToken map + premium + hours-to-next-US-cash-open.
 * Session: regular US equity hours 09:30 ET, Mon–Fri.
 */

const SYMBOLS = {
  NVDA: {
    symbol: 'NVDA',
    displayName: 'NVIDIA',
    cashTicker: 'NVDA',
    rtokenHint: 'NVDAUSDT / NVDA rToken',
  },
  TSLA: {
    symbol: 'TSLA',
    displayName: 'Tesla',
    cashTicker: 'TSLA',
    rtokenHint: 'TSLAUSDT / TSLA rToken',
  },
  AAPL: {
    symbol: 'AAPL',
    displayName: 'Apple',
    cashTicker: 'AAPL',
    rtokenHint: 'AAPLUSDT / AAPL rToken',
  },
};

function listSymbols() {
  return Object.keys(SYMBOLS);
}

function getSymbol(symbol) {
  const key = String(symbol || '').toUpperCase();
  return SYMBOLS[key] || null;
}

/**
 * premium = (rtoken - cash) / cash
 * Returns a decimal (0.012 = 1.2%).
 */
function premium(rtoken, cash) {
  const r = Number(rtoken);
  const c = Number(cash);
  if (!Number.isFinite(r) || !Number.isFinite(c) || c === 0) {
    return { value: null, ok: false, error: 'invalid cash/rtoken for premium' };
  }
  return { value: (r - c) / c, ok: true };
}

/**
 * Get current time parts in US Eastern (handles EST/EDT via Intl).
 */
function easternParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  // hour12:false can yield "24" for midnight in some engines — normalise
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday, // Sun Mon Tue ...
  };
}

function isWeekendEt(weekday) {
  return weekday === 'Sat' || weekday === 'Sun';
}

/**
 * Approximate next weekday 09:30 ET as a Date (UTC instant).
 * Uses iterative search from `from` in 15-min steps — adequate for hours-to-open.
 */
function hoursToNextUsCashOpen(from = new Date()) {
  const OPEN_MIN = 9 * 60 + 30; // 09:30
  const CLOSE_MIN = 16 * 60; // 16:00
  const nowEt = easternParts(from);
  const nowMin = nowEt.hour * 60 + nowEt.minute;
  const inSession =
    !isWeekendEt(nowEt.weekday) && nowMin >= OPEN_MIN && nowMin < CLOSE_MIN;

  // Walk forward calendar days in ET until we find the next 09:30 weekday open.
  for (let dayOffset = 0; dayOffset <= 10; dayOffset++) {
    const probe = new Date(from.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const et = easternParts(probe);
    if (isWeekendEt(et.weekday)) continue;

    const target = findEtInstant(et.year, et.month, et.day, 9, 30);
    if (!target) continue;

    if (dayOffset === 0 && nowMin >= OPEN_MIN) continue; // next open is a later session

    const hours = (target.getTime() - from.getTime()) / (1000 * 60 * 60);
    if (hours < -0.01) continue;
    return {
      hours: Math.max(0, hours),
      nextOpenEt: target.toISOString(),
      inSession,
      tag: 'computed',
    };
  }

  // Last-resort approximation so the field is never null for decay/UI.
  const approx = approximateNextOpen(from);
  return {
    hours: approx.hours,
    nextOpenEt: approx.nextOpenEt,
    inSession,
    tag: 'assumed',
    note: 'ET instant search missed; used UTC offset approximation for hoursToCashOpen.',
  };
}

/**
 * Fallback when findEtInstant cannot lock 09:30 ET (should be rare).
 */
function approximateNextOpen(from = new Date()) {
  const et = easternParts(from);
  const offsetGuess = isLikelyEdt(from) ? -4 : -5;
  let day = new Date(Date.UTC(et.year, et.month - 1, et.day, 9 - offsetGuess, 30, 0));
  for (let i = 0; i < 10; i++) {
    const p = easternParts(day);
    const mins = p.hour * 60 + p.minute;
    const nowMins = et.hour * 60 + et.minute;
    const sameDay = p.year === et.year && p.month === et.month && p.day === et.day;
    if (!isWeekendEt(p.weekday) && !(sameDay && nowMins >= 9 * 60 + 30)) {
      const hours = Math.max(0, (day.getTime() - from.getTime()) / 3.6e6);
      return { hours, nextOpenEt: day.toISOString() };
    }
    day = new Date(day.getTime() + 24 * 3600 * 1000);
  }
  return { hours: 24, nextOpenEt: new Date(from.getTime() + 24 * 3600 * 1000).toISOString() };
}

function isLikelyEdt(date) {
  // US Eastern daylight roughly Mar–Nov; good enough for fallback only.
  const p = easternParts(date);
  return p.month > 3 && p.month < 11;
}

/**
 * Find a UTC Date whose America/New_York local clock equals y-m-d h:mi.
 */
function findEtInstant(year, month, day, hour, minute) {
  // Rough guess: ET is UTC-5 or UTC-4
  for (const offsetHours of [-4, -5, -3, -6]) {
    const guess = new Date(Date.UTC(year, month - 1, day, hour - offsetHours, minute, 0));
    const p = easternParts(guess);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute
    ) {
      return guess;
    }
  }
  // Fine search around noon UTC that day
  const base = Date.UTC(year, month - 1, day, 12, 0, 0);
  for (let dMin = -20 * 60; dMin <= 20 * 60; dMin++) {
    const t = new Date(base + dMin * 60 * 1000);
    const p = easternParts(t);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute
    ) {
      return t;
    }
  }
  return null;
}

module.exports = {
  SYMBOLS,
  listSymbols,
  getSymbol,
  premium,
  hoursToNextUsCashOpen,
  easternParts,
};
