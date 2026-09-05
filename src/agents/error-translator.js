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

/**
 * Pulls a reset time out of a usage-limit message. The CLI has emitted this as
 * a bare unix timestamp appended after a pipe, and as an ISO instant; accept
 * either and ignore anything that is not a plausible near-future time, so a
 * version that changes the wording degrades to a message without a clock
 * rather than to a wrong one.
 */
export function parseResetTime(text, now = Date.now()) {
  const raw = String(text || '');
  const iso = raw.match(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/);
  if (iso) {
    const at = new Date(iso[0]);
    if (!Number.isNaN(at.getTime())) return at;
  }
  const epoch = raw.match(/\b(\d{10}|\d{13})\b/);
  if (epoch) {
    const n = Number(epoch[1]);
    const ms = epoch[1].length === 10 ? n * 1000 : n;
    // A reset is hours away at most; anything outside a week is some other
    // number that happens to be ten digits long.
    if (ms > now - 86_400_000 && ms < now + 7 * 86_400_000) return new Date(ms);
  }
  return null;
}

export function translateProviderError(err) {
  const status = err?.status ?? err?.statusCode;
  let msg = stripAnsi(err?.message || String(err));

  // A Claude subscription reports its own ceiling in prose rather than as a
  // status line, and on a Pro plan it is the failure a long agent run hits
  // first. Matched before the generic 429 so the message can name the plan
  // limit and, when the CLI included a reset time, say when it lifts.
  if (/usage limit reached|credit balance (?:is )?too low|upgrade to (?:max|pro)/i.test(msg)) {
    const resetAt = parseResetTime(msg);
    const when = resetAt ? ` Resets at ${resetAt.toLocaleString()}.` : '';
    return `Claude plan usage limit reached — this is the subscription's own ceiling, not an Ettore limit.${when} `
      + 'Wait for the window to reset, switch to a smaller model with /use, or connect an API-key provider.';
  }
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
