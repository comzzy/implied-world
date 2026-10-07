/**
 * Last real live run per symbol, stored in a private Vercel Blob store.
 * Only successful live runs (core legs observed) are written. Never seeded.
 * Auth lives in Vercel env (BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID + OIDC); never logged or returned.
 */
const SYMBOL_RE = /^[A-Z]{1,6}$/;
const SAVE_TIMEOUT_MS = 4000;
const LOAD_TIMEOUT_MS = 4000;

/** Auth: read-write token, or Vercel OIDC with BLOB_STORE_ID (SDK resolves the OIDC token). */
function storeAuth() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'token';
  if (process.env.BLOB_STORE_ID) return 'oidc';
  return null;
}

function storeReady() {
  return Boolean(storeAuth());
}

function keyFor(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!SYMBOL_RE.test(sym)) return null;
  return `latest/${sym}.json`;
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function isLiveSuccess(payload) {
  const f = payload && payload.freeze;
  return Boolean(
    payload &&
      payload.ok === true &&
      f &&
      f.cashClose?.tag === 'observed' &&
      f.rtoken?.tag === 'observed' &&
      f.premium?.tag === 'observed' &&
      Number.isFinite(Number(f.cashClose?.value)) &&
      Number.isFinite(Number(f.rtoken?.value))
  );
}

async function saveLastRun(payload) {
  if (!storeReady() || !isLiveSuccess(payload)) return { ok: false, skipped: true };
  const key = keyFor(payload.symbol || payload.freeze.symbol);
  if (!key) return { ok: false, skipped: true };
  try {
    const { put } = require('@vercel/blob');
    const record = {
      ...payload,
      stored: { asOf: payload.freeze.asOf, savedAt: new Date().toISOString() },
    };
    await withTimeout(
      put(key, JSON.stringify(record), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
      }),
      SAVE_TIMEOUT_MS
    );
    return { ok: true };
  } catch (err) {
    console.log('last-run save failed:', String(err.message || err).slice(0, 160));
    return { ok: false, error: 'save failed' };
  }
}

async function loadLastRun(symbol) {
  const key = keyFor(symbol);
  if (!key) return { ok: false, status: 400, error: 'Unknown symbol.' };
  if (!storeReady()) return { ok: false, status: 404, error: 'No stored live run.' };
  try {
    const { get } = require('@vercel/blob');
    const out = await withTimeout(get(key, { access: 'private', useCache: false }), LOAD_TIMEOUT_MS);
    if (!out || !out.stream) return { ok: false, status: 404, error: 'No stored live run.' };
    const text = await new Response(out.stream).text();
    const record = JSON.parse(text);
    if (!isLiveSuccess(record)) return { ok: false, status: 404, error: 'No stored live run.' };
    return { ok: true, record };
  } catch (err) {
    const msg = String(err.message || err);
    if (/not.?found|404/i.test(msg)) return { ok: false, status: 404, error: 'No stored live run.' };
    console.log('last-run load failed:', msg.slice(0, 160));
    return { ok: false, status: 503, error: 'Stored run unavailable.' };
  }
}

/** Attach the research note to the stored run only if it belongs to that exact freeze. */
async function attachBriefing(freeze, briefing) {
  if (!storeReady() || !briefing || !freeze?.asOf) return;
  const cur = await loadLastRun(freeze.symbol);
  const f = cur.ok ? cur.record?.freeze : null;
  if (
    !f ||
    f.asOf !== freeze.asOf ||
    f.cashClose?.value !== freeze.cashClose?.value ||
    f.rtoken?.value !== freeze.rtoken?.value
  ) {
    return;
  }
  await saveLastRun({ ...cur.record, briefing, briefing_error: null });
}

module.exports = { storeAuth, storeReady, saveLastRun, loadLastRun, attachBriefing, isLiveSuccess };
