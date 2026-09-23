/**
 * Strip trade-direction language from model/UI text.
 * Never allow BUY / SELL / LONG / SHORT or close variants.
 */

const FORBIDDEN = [
  /\bBUY\b/gi,
  /\bSELL\b/gi,
  /\bLONG\b/gi,
  /\bSHORT\b/gi,
  /\bgo\s+long\b/gi,
  /\bgo\s+short\b/gi,
  /\bgoing\s+long\b/gi,
  /\bgoing\s+short\b/gi,
  /\bconfidence\s*:\s*\d+\s*%?\s*buy\b/gi,
  /\bconfidence\s+buy\b/gi,
  /\bbuy\s+signal\b/gi,
  /\bsell\s+signal\b/gi,
  /\blong\s+signal\b/gi,
  /\bshort\s+signal\b/gi,
  /\benter\s+long\b/gi,
  /\benter\s+short\b/gi,
  /\bopen\s+long\b/gi,
  /\bopen\s+short\b/gi,
  /\btake\s+profit\b/gi,
  /\bstop\s+loss\b/gi,
];

const REPLACEMENTS = {
  BUY: '[direction omitted]',
  SELL: '[direction omitted]',
  LONG: '[side omitted]',
  SHORT: '[side omitted]',
};

function replaceToken(match) {
  const upper = String(match).toUpperCase().replace(/\s+/g, ' ').trim();
  if (upper === 'BUY' || upper === 'SELL') return REPLACEMENTS.BUY;
  if (upper === 'LONG' || upper === 'SHORT') return REPLACEMENTS.LONG;
  if (/GO\s+LONG|GOING\s+LONG|ENTER\s+LONG|OPEN\s+LONG|LONG\s+SIGNAL/.test(upper)) {
    return '[side omitted]';
  }
  if (/GO\s+SHORT|GOING\s+SHORT|ENTER\s+SHORT|OPEN\s+SHORT|SHORT\s+SIGNAL/.test(upper)) {
    return '[side omitted]';
  }
  if (/BUY\s+SIGNAL|CONFIDENCE.*BUY/.test(upper)) return '[direction omitted]';
  if (/SELL\s+SIGNAL/.test(upper)) return '[direction omitted]';
  if (/TAKE\s+PROFIT|STOP\s+LOSS/.test(upper)) return '[execution omitted]';
  return '[omitted]';
}

function sanitizeText(str) {
  if (str == null) return str;
  if (typeof str !== 'string') return str;
  let out = str;
  for (const re of FORBIDDEN) {
    out = out.replace(re, replaceToken);
  }
  // Second pass for residual bare tokens
  out = out.replace(/\b(BUY|SELL)\b/gi, REPLACEMENTS.BUY);
  out = out.replace(/\b(LONG|SHORT)\b/gi, (m) =>
    m.toUpperCase() === 'LONG' || m.toUpperCase() === 'SHORT'
      ? REPLACEMENTS.LONG
      : m
  );
  return out;
}

function sanitizeObject(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return sanitizeText(obj);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeObject(v);
  }
  return out;
}

function selfTest() {
  const samples = [
    'BUY NVDA',
    'go long TSLA',
    'confidence: 80% buy',
    'SELL AAPL and SHORT the wrapper',
  ];
  for (const s of samples) {
    const cleaned = sanitizeText(s);
    if (/\b(BUY|SELL|LONG|SHORT)\b/i.test(cleaned)) {
      throw new Error(`sanitize failed on "${s}" → "${cleaned}"`);
    }
  }
  return true;
}

module.exports = { sanitizeText, sanitizeObject, selfTest };
