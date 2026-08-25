// Explicit planning support for the ETTORE agent loop.
//
// Many agentic tasks are non-trivial: refactors, multi-file changes, schema
// migrations, anything that touches more than a couple of files. Letting the
// model dive straight into action wastes turns, produces low-quality first
// attempts, and gives the user zero opportunity to redirect before commit.
//
// This module adds three things:
//   1. shouldPlanExplicitly(prompt, config) — heuristic to decide if a user
//      prompt warrants an explicit plan before the main tool-calling loop.
//   2. PLANNING_REMINDER — a short instruction appended to the user prompt
//      that nudges the model to emit a <plan>...</plan> block up front. No
//      extra LLM call: the planning output is part of the model's first turn.
//   3. extractPlan(text) — parser for the <plan>...</plan> block. Returns a
//      structured object the agent (and UI) can consume, or null if the model
//      did not produce one.
//
// Design notes:
//   - Zero new LLM calls. The plan rides on the first turn's response.
//   - Fully opt-in via config.requireExplicitPlan (default: auto-detect).
//   - Parser is tolerant: accepts JSON, a markdown numbered list, or anything
//     that vaguely looks like a plan. Better to surface *something* than to
//     reject a partial plan and let the model skip planning entirely.

const PLAN_TRIGGER_PATTERNS = [
  // English triggers
  /\b(?:implement|build|create|develop|design|refactor|migrate|rewrite|restructure|redesign)\b/i,
  /\b(?:set up|configure|integrate|wire up|add support for|roll out)\b/i,
  /\b(?:several|multiple|few|all)\s+(?:steps?|tasks?|files?|components?|modules?|changes?)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bfrom scratch\b/i,
  // Italian triggers (used in Italian-language sessions)
  /\b(?:implementa|sviluppa|crea|progetta|refactor|riscrivi|riorganizza|migra|realizza)\b/i,
  /\bpasso[- ]per[- ]passo\b/i,
  /\bdall'inizio\b/i,
];

// Match a <plan>...</plan> block. Tolerant of whitespace and self-closing-ish
// variants; the inner body is captured for parsing.
const PLAN_BLOCK_RE = /<\s*plan\s*>([\s\S]*?)<\s*\/\s*plan\s*>/i;

// A trailing partial <plan / plan> tag that the streaming parser should hold
// back so the full block can be stripped before it reaches the UI.
const PARTIAL_PLAN_TAG_RE = /<\s*\/?\s*p(?:l(?:a(?:n)?)?)?$/i;

export function shouldPlanExplicitly(prompt, config = {}) {
  // Hard opt-out (e.g. tests, one-shot scripts, very fast paths).
  if (config.requireExplicitPlan === false) return false;
  if (config.explicitPlan === 'off') return false;
  if (config.explicitPlan === 'never') return false;

  // Hard opt-in (e.g. user passed --plan, or a plugin asked for one).
  if (config.requireExplicitPlan === true) return true;
  if (config.explicitPlan === 'always') return true;

  // Plan mode already restricts tools to read-only — keep the planning flow
  // on for visibility, even when the prompt is short.
  if (config.mode === 'plan') return true;

  const text = String(prompt || '').trim();
  if (!text) return false;

  // Check trigger phrases FIRST. They are the most reliable signal of a
  // non-trivial task, and they must override length heuristics — a 90-char
  // "refactor the auth module" is a complex task, not a 91-char "fix typo".
  for (const re of PLAN_TRIGGER_PATTERNS) {
    if (re.test(text)) return true;
  }

  // Length and complexity heuristics come second. A multi-sentence request
  // or a long single-sentence description still warrants planning.
  if (text.length < 100) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 18) return false;

  const sentenceCount = text.split(/[.!?]+\s+/).filter(s => s.trim().length > 0).length;
  if (sentenceCount >= 3) return true;

  return false;
}

// Short instruction appended to the user prompt when explicit planning is
// triggered. Intentionally compact: the model already has the original prompt
// in context, so we just nudge it to produce a structured <plan> block first.
//
// After the plan, the model begins executing immediately — no "wait for
// go-ahead" handshake. The plan is still surfaced to the user via the
// `plan` event for visibility, but stopping the agent mid-flow to ask
// permission made the CLI feel like a confirmation dialog instead of an
// assistant. Users who genuinely want the old "plan then wait" behavior
// can opt in per-turn by sending a follow-up message ("aspetta", "ferma",
// "wait") — that path goes through normal user-input handling, not the
// planning reminder. To disable planning entirely (and the brief context
// cost of producing a plan) set `requireExplicitPlan: false` in config.
export const PLANNING_REMINDER = `

[system note: this task looks non-trivial. Before you start calling tools, briefly outline a structured plan using this JSON shape, wrapped in <plan>...</plan> tags. The plan will be shown to the user for visibility, but you should begin executing the plan immediately after producing it — do not stop to wait for confirmation.]

<plan>
{
  "goal": "<one-line restatement of the user's request>",
  "assumptions": ["<assumption 1>", "..."],
  "steps": [
    {"id": 1, "title": "<step title>", "intent": "<what this achieves>", "tools": ["<tool>"], "risk": "low|medium|high"}
  ],
  "verification": "<how you will know it worked>"
}
</plan>

After the plan, write 1–2 sentences in natural language summarizing the approach, then begin executing the first step right away. The user will interrupt if they want to redirect — no confirmation handshake needed.`;

// Parse a <plan>...</plan> body. Returns a structured object or null.
// Three strategies, in order of preference:
//   1. Strict JSON. The shape described in PLANNING_REMINDER.
//   2. Loose JSON. Tolerates missing fields, extra whitespace, single quotes.
//   3. Plain numbered list. Last-resort fallback that still gives the UI
//      something useful to display.
export function extractPlan(text) {
  const match = String(text || '').match(PLAN_BLOCK_RE);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;

  // Strategy 1: strict JSON
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
      return normalizePlan(parsed, raw);
    }
  } catch {
    // fall through
  }

  // Strategy 2: loose JSON (strip trailing commas, accept single quotes)
  const loose = raw
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/'/g, '"');
  try {
    const parsed = JSON.parse(loose);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
      return normalizePlan(parsed, raw);
    }
  } catch {
    // fall through
  }

  // Strategy 3: markdown numbered list
  const steps = [];
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(\d+)[.)]\s+(.+?)$/);
    if (m) steps.push({ id: parseInt(m[1], 10), title: m[2].trim() });
  }
  if (steps.length >= 2) {
    return normalizePlan(
      { steps: steps.map(s => ({ id: s.id, title: s.title, risk: 'medium' })) },
      raw,
    );
  }

  return null;
}

function normalizePlan(parsed, raw) {
  const steps = (parsed.steps || []).slice(0, 12).map((s, i) => ({
    id: Number(s.id) || (i + 1),
    title: String(s.title || s.text || '').slice(0, 200),
    intent: String(s.intent || s.description || '').slice(0, 400),
    tools: Array.isArray(s.tools) ? s.tools.map(String).slice(0, 8) : [],
    risk: ['low', 'medium', 'high'].includes(String(s.risk).toLowerCase())
      ? String(s.risk).toLowerCase()
      : 'medium',
  }));
  return {
    goal: String(parsed.goal || '').slice(0, 500),
    assumptions: Array.isArray(parsed.assumptions)
      ? parsed.assumptions.map(String).slice(0, 10)
      : [],
    steps,
    verification: String(parsed.verification || '').slice(0, 400),
    raw,
  };
}

// Remove a fully-closed <plan>...</plan> block from a chunk of text. Used by
// the streaming path to keep the JSON scaffolding out of the visible reply.
// Mirrors stripMarkers() in stream-parser.js: null/undefined in, same out.
export function stripPlanBlock(text) {
  if (text == null) return text;
  return String(text).replace(/<\s*plan\s*>[\s\S]*?<\s*\/\s*plan\s*>\n?/gi, '');
}

export { PLAN_BLOCK_RE, PARTIAL_PLAN_TAG_RE };
