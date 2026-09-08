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

// Whether `msg` presents `code` as an HTTP status, rather than merely
// containing those digits.
//
// Matching a bare /429/ against the message text is a false-positive machine:
// token counts, byte offsets, request ids, model names and timestamps all
// contain three-digit runs, and any of them used to be reported to the user as
// a rate limit — with a confident explanation of a thing that had not
// happened. A provider that means a status writes it as one.
export function mentionsHttpStatus(msg, code) {
  const text = String(msg || '');
  const labelled = new RegExp(
    `(?:^|[^\\d])(?:HTTP[/ ]?|status(?:[ _]?code)?\\s*[:="']*\\s*|code\\s*[:="']*\\s*|error\\s+)${code}(?!\\d)`,
    'i',
  );
  const phrases = {
    429: 'too many requests|rate[ _-]?limit',
    401: 'unauthorized|unauthenticated',
    502: 'bad gateway',
    503: 'service unavailable',
    504: 'gateway timeout',
  }[code];
  const withPhrase = phrases
    ? new RegExp(`(?:^|[^\\d])${code}(?!\\d)[\\s:,-]*(?:${phrases})`, 'i')
    : null;
  return labelled.test(text) || Boolean(withPhrase?.test(text));
}

/**
 * @param {object} err            the provider error
 * @param {object} [context]
 * @param {number} [context.retriesSpent] how many retries the client actually
 *   made before giving up. The message may only claim to have retried when
 *   this says it did — it is a statement about what the CLI did, and it was
 *   being made unconditionally.
 */
export function translateProviderError(err, context = {}) {
  const status = err?.status ?? err?.statusCode;
  let msg = stripAnsi(err?.message || String(err));
  const retried = Number(context.retriesSpent) > 0;
  // When the classification comes from the text rather than a real status
  // code, the provider's own words go in the message too: a wrong guess is
  // then visible instead of replacing the only evidence the user had.
  const original = status ? '' : ` (provider said: ${msg.slice(0, 300)})`;

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
  // A 429 covers two situations with opposite remedies, and saying "wait and
  // retry" for both is wrong half the time: an exhausted balance never clears
  // on its own, while a per-minute rate limit clears in seconds. Providers do
  // distinguish them — MiniMax returns 1008 for balance, Anthropic and OpenAI
  // say "credit"/"insufficient_quota" in the body — so name which one it is.
  const outOfCredit = /insufficient[_ ]?(?:balance|quota|funds)|out of credit|no credit|billing|status_code["\s:]*100[89]\b/i.test(msg);
  if (outOfCredit) {
    return 'Provider credit or quota exhausted, not a temporary rate limit — waiting will not clear it. '
      + 'Top up the account or check the plan\'s usage page, or switch provider with /use.';
  }
  if (status === 429 || mentionsHttpStatus(msg, 429) || /rate[ _-]?limit|too many requests/i.test(msg)) {
    const already = retried
      ? `already retried ${context.retriesSpent} time${context.retriesSpent === 1 ? '' : 's'} with backoff and it did not clear. `
      : '';
    return `Provider rate limit (HTTP 429). ${already}`
      + 'The limit is per-minute on most plans, so a pause of a minute usually works; '
      + `if it keeps happening the plan quota is the real ceiling. /use switches model or provider.${original}`;
  }
  if (/quota/i.test(msg)) {
    return `Provider quota exceeded. Check the plan's usage page, or switch provider with /use.${original}`;
  }
  if (status === 401 || mentionsHttpStatus(msg, 401) || /unauthor/i.test(msg)) {
    return 'Authentication failed (HTTP 401). Run /connect to refresh your API key.';
  }
  if (status === 400 && /tool call and result not match|2013/i.test(msg)) {
    return `Provider rejected mismatched tool-call history: ${msg}`;
  }
  if (status === 400 && /tool/i.test(msg)) {
    return `Provider rejected the tool schema: ${msg}`;
  }
  if (status === 502 || mentionsHttpStatus(msg, 502) || /bad gateway|upstream request failed/i.test(msg)) {
    return `Provider gateway error (502) — the upstream model server failed. Retry in a moment. (${msg})`;
  }
  if (status === 503 || mentionsHttpStatus(msg, 503) || /service unavailable/i.test(msg)) {
    return `Provider unavailable (503) — service is temporarily down. Retry in a moment. (${msg})`;
  }
  if (status === 504 || mentionsHttpStatus(msg, 504) || /gateway timeout/i.test(msg)) {
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
