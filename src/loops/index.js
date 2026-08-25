// /loop — auto-generate a sequence of prompts from a high-level goal and
// feed them to the agent one at a time. Static plan (one LLM call upfront),
// user reviews + edits before execution, plans persisted on disk.
//
// Storage layout (per project):
//   <projectRoot>/.ettore/loops/<name>.json
//
// JSON shape:
//   {
//     "name": "auth-system",
//     "goal": "build me a login system with JWT",
//     "createdAt": "2026-08-19T...",
//     "provider": "openai",
//     "model": "gpt-4o",
//     "rationale": "...",
//     "steps": [
//       { "title": "Scaffold project", "prompt": "..." },
//       ...
//     ]
//   }
//
// Public API (all functions are pure / async, no side effects on agent state):
//   generatePlan(goal, { maxSteps, provider, model }) → { rationale, steps: [{title, prompt}] }
//   saveLoop(name, plan, meta)                        → { path, name }
//   loadLoop(name, { cwd })                           → plan
//   listLoops({ cwd })                                → [{ name, goal, createdAt, steps }]
//   deleteLoop(name, { cwd })                         → boolean
//   loopsDir({ cwd })                                 → absolute path

import { readFile, writeFile, mkdir, readdir, unlink, access } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { connectionManager } from '../providers/index.js';
import { createClient } from '../llm/client.js';

// ── Persistence ──────────────────────────────────────────────────────────────

function safeName(name) {
  // Filesystem-safe: lowercase, dashes/underscores only.
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function loopsDir({ cwd } = {}) {
  const root = resolve(cwd || process.cwd());
  return join(root, '.ettore', 'loops');
}

export async function listLoops({ cwd } = {}) {
  const dir = loopsDir({ cwd });
  if (!existsSync(dir)) return [];
  const files = await readdir(dir).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf-8');
      const data = JSON.parse(raw);
      out.push({
        name: data.name || f.replace(/\.json$/, ''),
        goal: data.goal || '',
        createdAt: data.createdAt || null,
        stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
        path: join(dir, f),
      });
    } catch {
      // skip corrupt files but keep going
    }
  }
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function loadLoop(name, { cwd } = {}) {
  const dir = loopsDir({ cwd });
  const file = join(dir, `${safeName(name)}.json`);
  const raw = await readFile(file, 'utf-8');
  return JSON.parse(raw);
}

export async function saveLoop(name, plan, meta = {}, { cwd } = {}) {
  const safe = safeName(name);
  if (!safe) throw new Error('Invalid loop name');
  const dir = loopsDir({ cwd });
  await mkdir(dir, { recursive: true });
  const data = {
    name: safe,
    goal: String(plan.goal || meta.goal || ''),
    rationale: String(plan.rationale || ''),
    steps: (plan.steps || []).map((s, i) => ({
      title: String(s.title || `Step ${i + 1}`).slice(0, 120),
      prompt: String(s.prompt || '').slice(0, 8000),
    })),
    createdAt: new Date().toISOString(),
    provider: meta.provider || connectionManager.activeProvider || null,
    model: meta.model || connectionManager.activeModel || null,
  };
  if (!data.steps.length) throw new Error('Cannot save an empty loop plan');
  const file = join(dir, `${safe}.json`);
  await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
  return { path: file, name: safe, data };
}

export async function deleteLoop(name, { cwd } = {}) {
  const safe = safeName(name);
  const file = join(loopsDir({ cwd }), `${safe}.json`);
  try {
    await access(file);
  } catch {
    return false;
  }
  await unlink(file);
  return true;
}

// ── Runtime state (shared between TUI and /loop command) ────────────────────
// The TUI mutates this object as steps advance; the command reads it for
// /loop status. Module-level on purpose: a single source of truth that both
// the interactive UI and the slash command can access without coupling.

const loopRuntime = {
  active: false,
  name: null,
  goal: null,
  rationale: null,
  steps: [],          // full step list (immutable copy of the enqueued plan)
  queue: [],          // remaining prompts to run
  currentIndex: 0,    // 0-based index of the step currently running
  totalSteps: 0,
  completedTitles: [], // titles of steps already finished
  startedAt: null,
};

export function getLoopStatus() {
  // Return a defensive copy so callers can't mutate the runtime state.
  return {
    active: loopRuntime.active,
    name: loopRuntime.name,
    goal: loopRuntime.goal,
    steps: loopRuntime.steps.slice(),
    queueLength: loopRuntime.queue.length,
    currentIndex: loopRuntime.currentIndex,
    totalSteps: loopRuntime.totalSteps,
    completedTitles: loopRuntime.completedTitles.slice(),
    startedAt: loopRuntime.startedAt,
  };
}

export function startLoopRuntime({ plan, name }) {
  // Filter steps to those with a non-empty prompt. normalizePlan already
  // does this on freshly-generated plans; this is the safety net for plans
  // loaded from disk or hand-built by callers.
  const cleanSteps = (plan.steps || []).filter(s => String(s?.prompt || '').trim().length > 0);
  loopRuntime.active = cleanSteps.length > 0;
  loopRuntime.name = name || null;
  loopRuntime.goal = plan.goal;
  loopRuntime.rationale = plan.rationale;
  loopRuntime.steps = cleanSteps;
  loopRuntime.queue = cleanSteps.map(s => s.prompt);
  loopRuntime.currentIndex = 0;
  loopRuntime.totalSteps = cleanSteps.length;
  loopRuntime.completedTitles = [];
  loopRuntime.startedAt = new Date().toISOString();
}

export function advanceLoopRuntime() {
  if (!loopRuntime.active) return null;
  // Mark the step that just finished as completed (currentIndex points to it
  // during its run; we increment AFTER).
  if (loopRuntime.currentIndex < loopRuntime.steps.length) {
    const justFinished = loopRuntime.steps[loopRuntime.currentIndex];
    if (justFinished?.title) loopRuntime.completedTitles.push(justFinished.title);
  }
  loopRuntime.currentIndex += 1;
  const next = loopRuntime.queue.shift();
  if (next == null) {
    // Queue empty — loop done.
    loopRuntime.active = false;
    return null;
  }
  return next;
}

export function stopLoopRuntime() {
  const wasActive = loopRuntime.active;
  loopRuntime.active = false;
  loopRuntime.queue = [];
  return wasActive;
}

// ── Plan generation ─────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a planning assistant for a coding agent CLI (similar to Claude Code / OpenCode).

The user gives you a high-level goal. The agent has NO memory of this conversation and will only see the prompt you produce. You must break the goal into a sequence of self-contained sub-prompts that, when fed to the agent one at a time in the same conversation, will accomplish the goal.

Hard constraints for each sub-prompt:
- Self-contained: the agent has no memory of this planning step. Reference prior outputs by what they should produce (file paths, function names, commands). Don't say "as planned" or "as we discussed".
- One main deliverable per step. Each step produces something verifiable: a file, a passing test, a CLI output, a git commit, etc.
- Sequential: step 2 assumes step 1 has been completed. Be explicit about what is now in place when prompt N starts.
- Concrete: prefer file paths, function names, exact commands over abstract descriptions.
- Tool-aware: the agent has bash, read, write, edit, glob, grep, git_status, websearch, webfetch, run_tests, run_checks. Pick the right ones.
- Safe: do NOT include destructive commands (rm -rf, force push, chmod 777) in the prompts.

Number of steps: 3-7 by default. Use fewer for simple goals, more for complex multi-component builds. Don't pad.

Output JSON only — no prose, no markdown fences, no commentary. The JSON must match this shape exactly:

{"rationale":"<one or two sentences explaining the plan>","steps":[{"title":"<short step name, max 80 chars>","prompt":"<full prompt to send to the agent, can be multiple lines, must be self-contained>"}]}`;

const PLANNER_USER_TEMPLATE = (goal, maxSteps) =>
  `Goal: ${goal}\n\nMaximum number of steps: ${maxSteps}.\n\nReturn only the JSON object described in the system instructions.`;

// Strip code fences, leading prose, and trailing prose around the JSON.
// Models often wrap JSON in ```json ... ``` even when told not to.
function extractJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  // Try direct parse first
  try { return JSON.parse(trimmed); } catch {}
  // Strip ```json ... ``` or ``` ... ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // Find first { ... last } (greedy-ish: from first { to last })
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function normalizePlan(raw, { goal, maxSteps }) {
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  const clean = steps
    .map((s, i) => ({
      title: String(s?.title || `Step ${i + 1}`).trim().slice(0, 120) || `Step ${i + 1}`,
      prompt: String(s?.prompt || '').trim(),
    }))
    .filter(s => s.prompt.length > 0)
    .slice(0, Math.max(1, maxSteps));
  if (!clean.length) return null;
  return {
    rationale: String(raw?.rationale || '').trim().slice(0, 1000),
    goal,
    steps: clean,
  };
}

/**
 * Call the active LLM once and return a parsed plan. The LLM is used with
 * low temperature (0.4) for determinism. Reuses the active provider/model
 * the user is already on — no new connection required.
 *
 * Throws on provider errors or if the model output can't be parsed as JSON.
 */
export async function generatePlan(goal, { maxSteps = 5, temperature = 0.4 } = {}) {
  const text = String(goal || '').trim();
  if (!text) throw new Error('Goal is empty');
  const provider = connectionManager.activeProvider;
  const model = connectionManager.activeModel;
  if (!provider || !model) {
    throw new Error('No active model. Use /use to select one before running /loop.');
  }

  const client = createClient({ provider, model, modelParams: { temperature } });
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: PLANNER_USER_TEMPLATE(text, maxSteps) },
  ];

  // No tools needed for planning. The planner should never call tools —
  // it's a pure text-to-JSON task.
  const result = await client.turn(messages, [], null, null);
  const content = result?.type === 'text' ? result.content : '';
  if (!content) throw new Error('Planner LLM returned no content');

  const parsed = extractJson(content);
  if (!parsed) {
    throw new Error(
      'Planner LLM did not return valid JSON. Try rephrasing the goal, or use a more capable model.\n'
      + `Raw output (first 300 chars):\n${String(content).slice(0, 300)}`,
    );
  }
  const plan = normalizePlan(parsed, { goal: text, maxSteps });
  if (!plan) {
    throw new Error('Planner JSON had no usable steps. Try rephrasing the goal.');
  }
  return plan;
}
