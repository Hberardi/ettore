// Translate raw LLM-provider errors into actionable, user-facing messages.
//
// Providers expose failures in inconsistent shapes: HTTP status codes, error
// names, and free-form messages that may include ANSI escapes copied from
// upstream JSON. Centralize the mapping here so the agent loop can stay clean.

const ANSI_RE = /(\x9B|\x1B\[)[0-9;:]*[ -/]*[@-~]/g;
const ANSI_CTRL_RE = /\x1B[@-_]/g;

export function stripAnsi(text) {
  return String(text || '')
    .replace(ANSI_RE, '')
    .replace(ANSI_CTRL_RE, '');
}

export function translateProviderError(err) {
  const status = err?.status ?? err?.statusCode;
  let msg = stripAnsi(err?.message || String(err));

  if (status === 429 || /429|rate.?limit|quota/i.test(msg)) {
    return 'Rate limit / quota exceeded (HTTP 429). Wait a moment and retry, or check your provider billing/usage.';
  }
  if (status === 401 || /401|unauthor/i.test(msg)) {
    return 'Authentication failed (HTTP 401). Run /connect to refresh your API key.';
  }
  if (status === 400 && /tool call and result not match|2013/i.test(msg)) {
    return `Provider rejected mismatched tool-call history: ${msg}`;
  }
  if (status === 400 && /tool/i.test(msg)) {
    return `Provider rejected the tool schema: ${msg}`;
  }
  if (status === 502 || /502|bad gateway|upstream request failed/i.test(msg)) {
    return `Provider gateway error (502) — the upstream model server failed. Retry in a moment. (${msg})`;
  }
  if (status === 503 || /503|service unavailable/i.test(msg)) {
    return `Provider unavailable (503) — service is temporarily down. Retry in a moment. (${msg})`;
  }
  if (status === 504 || /504|gateway timeout/i.test(msg)) {
    return `Provider gateway timeout (504) — upstream model took too long. Try a shorter prompt. (${msg})`;
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `Connection refused — provider not running or unreachable. (${msg})`;
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    return `DNS lookup failed — check network or endpoint URL. (${msg})`;
  }
  if (/request timed out|ETIMEDOUT|socket hang up|network timeout/i.test(msg)) {
    return `Request timed out — the model took too long to respond. Try a faster model or a shorter prompt. (${msg})`;
  }
  if (/ECONNRESET/i.test(msg)) {
    return `Connection reset by provider — transient error, please retry. (${msg})`;
  }
  return msg;
}
