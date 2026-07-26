import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  renderSystemPrompt,
  needsProviderQuirksPrompt,
} from '../src/agents/prompts.js';

test('BUILD_SYSTEM_PROMPT contains the TOOL CALL PROTOCOL section', () => {
  assert.ok(BUILD_SYSTEM_PROMPT.includes('## TOOL CALL PROTOCOL'),
    'build prompt must document the tool-call protocol');
  assert.ok(BUILD_SYSTEM_PROMPT.includes('Complete JSON'),
    'build prompt must warn about JSON truncation');
  assert.ok(BUILD_SYSTEM_PROMPT.includes('No empty objects'),
    'build prompt must warn about empty-argument tool calls');
  // Must include a concrete valid example
  assert.ok(/"name":\s*"read"/.test(BUILD_SYSTEM_PROMPT),
    'build prompt must include a valid tool_call example');
  // Must include a concrete invalid example
  assert.ok(/"arguments":\s*\{\}/.test(BUILD_SYSTEM_PROMPT),
    'build prompt must show the empty-object anti-pattern');
  assert.ok(/truncated/i.test(BUILD_SYSTEM_PROMPT),
    'build prompt must call out truncated JSON');
});

test('PLAN_SYSTEM_PROMPT also documents the tool-call protocol', () => {
  assert.ok(PLAN_SYSTEM_PROMPT.includes('## TOOL CALL PROTOCOL'),
    'plan prompt must also document the tool-call protocol');
  // Plan mode is read-only but still has read/grep/glob which suffer the
  // same JSON truncation problem. Verify the same rule set applies.
  assert.ok(PLAN_SYSTEM_PROMPT.includes('Complete JSON') ||
            /same rules as build mode/i.test(PLAN_SYSTEM_PROMPT));
});

test('renderSystemPrompt substitutes WORKDIR and preserves the new section', () => {
  const out = renderSystemPrompt('build', '/tmp/example');
  assert.ok(out.includes('/tmp/example'),
    'workdir must be substituted');
  assert.ok(out.includes('## TOOL CALL PROTOCOL'),
    'rendered prompt must keep the protocol section');
  assert.ok(!out.includes('{{WORKDIR}}'),
    '{{WORKDIR}} placeholder must be replaced');
});

test('renderSystemPrompt preserves protocol in plan mode', () => {
  const out = renderSystemPrompt('plan', '/home/user/proj');
  assert.ok(out.includes('## TOOL CALL PROTOCOL'),
    'plan rendered prompt must keep the protocol section');
  assert.ok(out.includes('/home/user/proj'));
});

test('renderSystemPrompt appends caveman overlay when active', () => {
  const plain = renderSystemPrompt('build', '/tmp/x');
  const caveman = renderSystemPrompt('build', '/tmp/x', { cavemanLevel: 'full' });
  assert.ok(plain.includes('## TOOL CALL PROTOCOL'));
  assert.ok(caveman.includes('## TOOL CALL PROTOCOL'));
  assert.ok(caveman.includes('CAVEMAN MODE ACTIVE'),
    'caveman overlay must be appended');
  assert.ok(caveman.length > plain.length,
    'caveman overlay must add content');
});

test('MiniMax gets the model-specific hard rules appended', () => {
  const out = renderSystemPrompt('build', '/tmp/x', { provider: 'minimax', model: 'MiniMax-M3' });
  assert.match(out, /MODEL-SPECIFIC HARD RULES/);
  // The three failure modes actually observed with this family.
  assert.match(out, /NEVER write tool-call markup as text/i);
  assert.match(out, /todo_write.*action="complete".*SAME tool batch/s);
  assert.match(out, /Announcing is not doing/i);
  // The generic rules must survive alongside it.
  assert.match(out, /The working directory is: \/tmp\/x/);
});

test('the hard rules are not paid for by models that do not need them', () => {
  for (const [provider, model] of [['openai', 'gpt-4o'], ['anthropic', 'claude-sonnet-5'], ['ollama', 'qwen2.5-coder']]) {
    const out = renderSystemPrompt('build', '/tmp/x', { provider, model });
    assert.ok(!out.includes('MODEL-SPECIFIC HARD RULES'), `${provider}/${model} must not carry the MiniMax addendum`);
  }
});

test('the hard rules apply in plan mode and stack with caveman', () => {
  const out = renderSystemPrompt('plan', '/tmp/x', {
    provider: 'minimax',
    model: 'MiniMax-M2.7',
    cavemanLevel: 'full',
  });
  assert.match(out, /MODEL-SPECIFIC HARD RULES/);
  assert.match(out, /CAVEMAN MODE ACTIVE/);
});

test('needsProviderQuirksPrompt matches the MiniMax family by provider or model id', () => {
  assert.equal(needsProviderQuirksPrompt('minimax', 'MiniMax-M3'), true);
  assert.equal(needsProviderQuirksPrompt('openrouter', 'minimax/minimax-m2'), true);
  assert.equal(needsProviderQuirksPrompt('openrouter', 'MiniMax-M2.7-highspeed'), true);
  assert.equal(needsProviderQuirksPrompt('openai', 'gpt-4o'), false);
  assert.equal(needsProviderQuirksPrompt('', ''), false);
});
