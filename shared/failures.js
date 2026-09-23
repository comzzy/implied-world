/**
 * Classify desk/API failures for honest UI copy.
 * Kinds: network | api | timeout | missing_data | writeup | server
 */
function classifyFailure(err, opts = {}) {
  const status = opts.status != null ? Number(opts.status) : null;
  const msg = String(
    (err && err.message) || err || opts.message || opts.error || 'Unknown failure'
  );
  const soft = Boolean(opts.soft || opts.writeup);

  if (soft || opts.kind === 'writeup' || /briefing|writeup|qwen|qwen/i.test(msg)) {
    return {
      failureKind: 'writeup',
      failureMessage: 'Writeup failed — numbers are still OK. ' + short(msg),
      ok: true,
      soft: true,
    };
  }
  if (opts.kind === 'missing_data' || /missing|absent|required quote|no cash|no rtoken|no wrapper/i.test(msg)) {
    return {
      failureKind: 'missing_data',
      failureMessage: 'Server failed — missing data. ' + short(msg),
      ok: false,
    };
  }
  if (
    opts.kind === 'timeout' ||
    /timeout|timed out|AbortError|ETIMEDOUT/i.test(msg) ||
    status === 504
  ) {
    return {
      failureKind: 'timeout',
      failureMessage: 'Server failed — timeout. ' + short(msg),
      ok: false,
    };
  }
  if (
    opts.kind === 'network' ||
    /fetch failed|network|ECONNRESET|ENOTFOUND|offline|Failed to fetch|TypeError: Failed/i.test(msg)
  ) {
    return {
      failureKind: 'network',
      failureMessage: 'Server failed — network. ' + short(msg),
      ok: false,
    };
  }
  if (
    opts.kind === 'api' ||
    (status >= 400 && status < 600) ||
    /MCP error|HTTP 4|HTTP 5|api error|do_query/i.test(msg)
  ) {
    return {
      failureKind: 'api',
      failureMessage: 'Server failed — API. ' + short(msg),
      ok: false,
    };
  }
  return {
    failureKind: 'server',
    failureMessage: 'Server failed. ' + short(msg),
    ok: false,
  };
}

function short(msg) {
  return String(msg || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function failurePayload(err, opts = {}) {
  const c = classifyFailure(err, opts);
  return {
    ok: false,
    error: c.failureMessage,
    failureKind: c.failureKind,
    failureMessage: c.failureMessage,
    banner: 'Human decides. This desk does not trade.',
  };
}

module.exports = { classifyFailure, failurePayload };
