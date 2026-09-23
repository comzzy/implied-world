/**
 * Qwen chat client — writeup / reasoning only.
 * Bitget market data is ground truth; never invent prices when the key is missing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

function getConfig() {
  return {
    apiKey: process.env.BITGET_QWEN_API_KEY || '',
    baseUrl: (process.env.QWEN_BASE_URL || '').replace(/\/$/, ''),
    model: process.env.QWEN_MODEL || 'qwen3.8-max',
  };
}

function hasKey() {
  return Boolean(getConfig().apiKey && getConfig().apiKey.trim());
}

/**
 * chat({ messages, json?: true })
 * POST {base}/chat/completions with Bearer key.
 * Fallback: try {base}/responses if chat fails.
 */
async function chat({ messages, json = false, timeoutMs, maxTokens, temperature } = {}) {
  const cfg = getConfig();
  if (!cfg.apiKey || !cfg.apiKey.trim()) {
    throw new Error(
      'BITGET_QWEN_API_KEY is not set. Qwen writeup is unavailable; numeric desk still runs without it.'
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chat() requires a non-empty messages array');
  }

  const body = {
    model: cfg.model,
    messages,
    temperature: temperature != null ? Number(temperature) : 0.15,
    max_tokens: Number(maxTokens) || Number(process.env.QWEN_MAX_TOKENS) || 420,
  };
  if (json) {
    body.response_format = { type: 'json_object' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  const effectiveTimeout = Number(timeoutMs) || Number(process.env.QWEN_TIMEOUT_MS) || 50000;

  async function fetchWithTimeout(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), effectiveTimeout);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Primary: OpenAI-compatible chat/completions
  let lastError = null;
  try {
    const res = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      return parseChatResponse(text, json);
    }
    lastError = `chat/completions HTTP ${res.status}: ${text.slice(0, 400)}`;
  } catch (err) {
    lastError = `chat/completions network: ${err.name === 'AbortError' ? `timeout ${effectiveTimeout}ms` : err.message}`;
  }

  // Fallback: /responses
  try {
    const resBody = {
      model: cfg.model,
      input: messages.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
    };
    if (json) resBody.text = { format: { type: 'json_object' } };
    const res = await fetchWithTimeout(`${cfg.baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(resBody),
    });
    const text = await res.text();
    if (res.ok) {
      return parseResponsesApi(text, json);
    }
    lastError = `${lastError}; responses HTTP ${res.status}: ${text.slice(0, 400)}`;
  } catch (err) {
    lastError = `${lastError}; responses network: ${err.message}`;
  }

  throw new Error(`Qwen request failed. ${lastError}`);
}

function parseChatResponse(text, wantJson) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Qwen returned non-JSON chat response');
  }
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.output_text ??
    null;
  if (content == null) {
    throw new Error('Qwen chat response missing content');
  }
  if (wantJson) {
    if (typeof content === 'object') return content;
    return JSON.parse(stripCodeFence(String(content)));
  }
  return String(content);
}

function parseResponsesApi(text, wantJson) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Qwen returned non-JSON responses payload');
  }
  let content =
    data?.output_text ??
    data?.response ??
    data?.choices?.[0]?.message?.content ??
    null;
  if (content == null && Array.isArray(data?.output)) {
    const parts = data.output
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === 'output_text' || c.text)
      .map((c) => c.text || c.output_text)
      .filter(Boolean);
    content = parts.join('\n');
  }
  if (content == null) throw new Error('Qwen responses payload missing content');
  if (wantJson) {
    if (typeof content === 'object') return content;
    return JSON.parse(stripCodeFence(String(content)));
  }
  return String(content);
}

function stripCodeFence(s) {
  const m = String(s).match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : String(s).trim();
}

module.exports = { chat, hasKey, getConfig };
