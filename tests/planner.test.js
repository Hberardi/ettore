import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldPlanExplicitly,
  extractPlan,
  stripPlanBlock,
  PLANNING_REMINDER,
} from '../src/agents/planner.js';
import {
  PLAN_BLOCK_RE,
  PLAN_CAPTURE_RE,
  PARTIAL_TAG_OPEN_RE,
  PARTIAL_TAG_CLOSE_RE,
  stripMarkers,
} from '../src/agents/stream-parser.js';

test('shouldPlanExplicitly: short prompts do not trigger planning', () => {
  assert.equal(shouldPlanExplicitly('fix the bug', {}), false);
  assert.equal(shouldPlanExplicitly('hi', {}), false);
  assert.equal(shouldPlanExplicitly('', {}), false);
  assert.equal(shouldPlanExplicitly(null, {}), false);
});

test('shouldPlanExplicitly: long single-sentence prompts do not trigger by default', () => {
  // Long but no trigger words and only one sentence.
  const text = 'Please read the file at src/index.js and tell me what it does in detail without modifying anything else right now';
  assert.equal(shouldPlanExplicitly(text, {}), false);
});

test('shouldPlanExplicitly: multi-sentence triggers planning', () => {
  const text = 'Add a new endpoint to the auth service. Then update the OpenAPI spec. Finally add a test for the new endpoint.';
  assert.equal(shouldPlanExplicitly(text, {}), true);
});

test('shouldPlanExplicitly: English trigger words', () => {
  assert.equal(shouldPlanExplicitly(
    'Please refactor the user service to split the validation logic out into a separate module, then update the call sites and write tests for the new module.',
    {},
  ), true);
  assert.equal(shouldPlanExplicitly(
    'Set up a CI pipeline that runs lint, type-check, unit tests, and integration tests on every PR with proper caching and artifact upload.',
    {},
  ), true);
  assert.equal(shouldPlanExplicitly(
    'Migrate the database from MySQL to PostgreSQL, including rewriting the migration scripts and updating the ORM models.',
    {},
  ), true);
});

test('shouldPlanExplicitly: Italian trigger words', () => {
  assert.equal(shouldPlanExplicitly(
    'Implementa un nuovo endpoint per il servizio di autenticazione, aggiorna la documentazione OpenAPI e scrivi i test per il nuovo endpoint.',
    {},
  ), true);
  assert.equal(shouldPlanExplicitly(
    'Riscrivi il modulo di validazione separando la logica in un file dedicato, aggiorna i call site esistenti e aggiungi i test per il nuovo modulo.',
    {},
  ), true);
});

test('shouldPlanExplicitly: opt-out via requireExplicitPlan=false', () => {
  const text = 'Implement a brand new feature with multiple components and several files involved.';
  assert.equal(shouldPlanExplicitly(text, { requireExplicitPlan: false }), false);
});

test('shouldPlanExplicitly: opt-out via explicitPlan=off', () => {
  const text = 'Implement a brand new feature with multiple components and several files involved.';
  assert.equal(shouldPlanExplicitly(text, { explicitPlan: 'off' }), false);
});

test('shouldPlanExplicitly: opt-in via requireExplicitPlan=true', () => {
  assert.equal(shouldPlanExplicitly('fix typo', { requireExplicitPlan: true }), true);
});

test('shouldPlanExplicitly: plan mode always plans', () => {
  assert.equal(shouldPlanExplicitly('hi', { mode: 'plan' }), true);
  assert.equal(shouldPlanExplicitly('', { mode: 'plan' }), true);
});

test('extractPlan: strict JSON', () => {
  const text = `<plan>
{
  "goal": "Add a /health endpoint",
  "assumptions": ["no auth needed"],
  "steps": [
    {"id": 1, "title": "Add route", "intent": "expose /health", "tools": ["edit"], "risk": "low"},
    {"id": 2, "title": "Write test", "intent": "verify", "tools": ["bash"], "risk": "low"}
  ],
  "verification": "curl returns 200"
}
</plan>`;
  const plan = extractPlan(text);
  assert.ok(plan);
  assert.equal(plan.goal, 'Add a /health endpoint');
  assert.equal(plan.assumptions.length, 1);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].title, 'Add route');
  assert.equal(plan.steps[0].risk, 'low');
  assert.equal(plan.steps[1].tools[0], 'bash');
  assert.equal(plan.verification, 'curl returns 200');
});

test('extractPlan: loose JSON (trailing commas, single quotes)', () => {
  const text = `<plan>{
  'goal': 'Refactor X',
  'steps': [
    {'id': 1, 'title': 'Move code', 'risk': 'medium',},
    {'id': 2, 'title': 'Update tests', 'risk': 'low',}
  ],
}</plan>`;
  const plan = extractPlan(text);
  assert.ok(plan);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].title, 'Move code');
  assert.equal(plan.steps[1].risk, 'low');
});

test('extractPlan: numbered list fallback', () => {
  const text = `<plan>
1. First step
2. Second step
3. Third step
</plan>`;
  const plan = extractPlan(text);
  assert.ok(plan);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].title, 'First step');
  assert.equal(plan.steps[0].risk, 'medium'); // default
});

test('extractPlan: returns null when no block present', () => {
  assert.equal(extractPlan('plain text'), null);
  assert.equal(extractPlan('<plan></plan>'), null); // empty body
  assert.equal(extractPlan('<plan>just one line, no list</plan>'), null);
});

test('extractPlan: returns null when block has only one numbered item', () => {
  const text = `<plan>
1. Only one step
</plan>`;
  assert.equal(extractPlan(text), null);
});

test('extractPlan: tolerant of whitespace and case', () => {
  const text = `<PLAN>\n  \n  {\n    "goal": "g",\n    "steps": [{"id": 1, "title": "s1"}, {"id": 2, "title": "s2"}]\n  }\n  \n</PLAN>`;
  const plan = extractPlan(text);
  assert.ok(plan);
  assert.equal(plan.steps.length, 2);
});

test('extractPlan: caps steps at 12 and trims long fields', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    title: 't'.repeat(500),
    intent: 'i'.repeat(1000),
    tools: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  }));
  const text = `<plan>${JSON.stringify({ goal: 'g'.repeat(1000), steps: many })}</plan>`;
  const plan = extractPlan(text);
  assert.ok(plan);
  assert.equal(plan.steps.length, 12);
  assert.ok(plan.steps[0].title.length <= 200);
  assert.ok(plan.steps[0].intent.length <= 400);
  assert.ok(plan.steps[0].tools.length <= 8);
  assert.ok(plan.goal.length <= 500);
});

test('stripPlanBlock: removes the plan block, preserves surrounding text', () => {
  const input = 'before <plan>{"steps":[{"id":1,"title":"a"},{"id":2,"title":"b"}]}</plan> after';
  const out = stripPlanBlock(input);
  assert.ok(!out.includes('<plan>'));
  assert.ok(!out.includes('</plan>'));
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
});

test('stripPlanBlock: tolerant of whitespace and case', () => {
  const input = 'a <PLAN> x </PLAN> b <plan>y</plan> c';
  const out = stripPlanBlock(input);
  assert.equal(out, 'a  b  c');
});

test('stripPlanBlock: returns input unchanged when no block', () => {
  assert.equal(stripPlanBlock('plain text'), 'plain text');
  assert.equal(stripPlanBlock(''), '');
  assert.equal(stripPlanBlock(null), null);
});

test('stripMarkers: also removes plan block', () => {
  const input = 'before <plan>{"steps":[{"id":1,"title":"a"},{"id":2,"title":"b"}]}</plan> after';
  const out = stripMarkers(input);
  assert.ok(!out.includes('<plan>'));
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
});

test('PLANNING_REMINDER: contains a complete <plan> example the model can copy', () => {
  assert.ok(PLANNING_REMINDER.includes('<plan>'));
  assert.ok(PLANNING_REMINDER.includes('</plan>'));
  assert.ok(PLANNING_REMINDER.includes('"steps"'));
  assert.ok(PLANNING_REMINDER.includes('"title"'));
  assert.ok(PLANNING_REMINDER.includes('"risk"'));
});

test('PLAN_CAPTURE_RE: matches well-formed blocks', () => {
  assert.ok(PLAN_CAPTURE_RE.test('<plan>x</plan>'));
  assert.ok(PLAN_CAPTURE_RE.test('< plan >x</ plan >'));
  assert.ok(PLAN_CAPTURE_RE.test('<PLAN>x</PLAN>'));
});

test('PARTIAL_TAG_OPEN_RE: holds back partial plan tags during streaming', () => {
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <p'));
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <pl'));
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <pla'));
  assert.ok(PARTIAL_TAG_OPEN_RE.test('text <plan'));
  // After the tag name ends, the holdback releases (the regex does not match
  // arbitrary trailing characters beyond the tag name).
  assert.ok(!PARTIAL_TAG_OPEN_RE.test('text <plan>'));
});

test('PARTIAL_TAG_CLOSE_RE: holds back partial closing plan tags', () => {
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\'));
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\/'));
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\/pl'));
  assert.ok(PARTIAL_TAG_CLOSE_RE.test('text <\\/plan'));
});
