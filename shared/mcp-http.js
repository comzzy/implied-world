/**
 * Shared JSON-RPC MCP over HTTP (streamable HTTP / SSE).
 * Handles initialize → mcp-session-id, timeouts, soft failures, retries.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createMcpClient(baseUrl, source, opts = {}) {
  const defaultTimeoutMs = opts.timeoutMs ?? 4000;
  const defaultRetries = opts.retries ?? 0;
  const backoffMs = opts.backoffMs ?? 400;
  let sessionId = null;
  let initialized = false;
  let initError = null;

  async function rawFetch(bodyObj, extraHeaders = {}, timeoutMs = defaultTimeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extraHeaders,
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj),
        signal: ctrl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      const ct = res.headers.get('content-type') || '';
      const raw = await res.text();
      return { res, ct, raw };
    } finally {
      clearTimeout(t);
    }
  }

  function parseBody(ct, raw) {
    if (ct.includes('text/event-stream') || raw.startsWith('event:') || raw.includes('\ndata:')) {
      const lines = raw.split(/\r?\n/);
      let last = null;
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          last = JSON.parse(payload);
        } catch {
          /* skip */
        }
      }
      return last;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function isRetryable(errMsg, status) {
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    return /timeout|abort|network|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(errMsg || ''));
  }

  async function rpc(method, params = {}, id = Date.now(), callOpts = {}) {
    const timeoutMs = callOpts.timeoutMs ?? defaultTimeoutMs;
    const retries = callOpts.retries ?? defaultRetries;
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { res, ct, raw } = await rawFetch(
          { jsonrpc: '2.0', id: id + attempt, method, params },
          {},
          timeoutMs
        );
        if (!res.ok) {
          last = {
            ok: false,
            error: `HTTP ${res.status}: ${raw.slice(0, 300)}`,
            source,
            status: res.status,
          };
          if (attempt < retries && isRetryable(last.error, res.status)) {
            await sleep(backoffMs * (attempt + 1));
            continue;
          }
          return last;
        }
        const data = parseBody(ct, raw);
        if (!data) {
          last = { ok: false, error: `unparsed body: ${raw.slice(0, 200)}`, source };
          if (attempt < retries) {
            await sleep(backoffMs * (attempt + 1));
            continue;
          }
          return last;
        }
        if (data.error) {
          return {
            ok: false,
            error: JSON.stringify(data.error).slice(0, 400),
            source,
            code: data.error.code,
          };
        }
        return { ok: true, result: data.result, source };
      } catch (err) {
        const msg = err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message;
        last = { ok: false, error: msg, source };
        if (attempt < retries && isRetryable(msg)) {
          await sleep(backoffMs * (attempt + 1));
          continue;
        }
        return last;
      }
    }
    return last || { ok: false, error: 'rpc failed', source };
  }

  async function ensureSession() {
    if (initialized) return { ok: true };
    // Allow one soft re-init after prior failure (e.g. transient timeout)
    const init = await rpc(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'implied-world', version: '1.0.0' },
      },
      Date.now(),
      { retries: 1 }
    );

    if (!init.ok) {
      initError = init.error;
      return { ok: false, error: init.error, source };
    }

    initialized = true;
    initError = null;
    try {
      await rawFetch({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      });
    } catch {
      /* ignore */
    }
    return { ok: true, result: init.result, source };
  }

  async function listTools(callOpts = {}) {
    const sess = await ensureSession();
    const out = await rpc('tools/list', {}, Date.now(), callOpts);
    if (!out.ok && !sess.ok) {
      return {
        ok: false,
        error: `init: ${sess.error}; list: ${out.error}`,
        source,
        unreachable: true,
      };
    }
    if (!out.ok) return { ...out, unreachable: /session|401|403|timeout/i.test(out.error || '') };
    return out;
  }

  async function callTool(name, args = {}, callOpts = {}) {
    await ensureSession();
    return rpc('tools/call', { name, arguments: args }, Date.now(), callOpts);
  }

  async function probeReachable() {
    initialized = false;
    initError = null;
    sessionId = null;
    const out = await listTools({ retries: 1 });
    return {
      ok: Boolean(out.ok),
      source,
      detail: out.ok
        ? `tools/list ok (${Array.isArray(out.result?.tools) ? out.result.tools.length : '?'} tools)`
        : out.error,
      session: Boolean(sessionId),
    };
  }

  function reset() {
    sessionId = null;
    initialized = false;
    initError = null;
  }

  return { listTools, callTool, probeReachable, rpc, ensureSession, reset };
}

module.exports = { createMcpClient };
