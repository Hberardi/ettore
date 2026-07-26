import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSystemPrompt } from '../src/agents/prompts.js';
import { Agent } from '../src/agents/index.js';

test('renderSystemPrompt appends caveman instructions when enabled', () => {
  const prompt = renderSystemPrompt('build', '/tmp/project', { cavemanLevel: 'full' });

  assert.match(prompt, /CAVEMAN MODE ACTIVE \(full\)/);
  assert.match(prompt, /Respond terse like smart caveman/);
});

test('agent rebuilds system prompt when caveman mode changes', () => {
  const agent = new Agent({}, { workdir: '/tmp/project', verifyAfterEdit: false }, 'build');

  agent.setCavemanLevel('ultra');
  assert.equal(agent.cavemanLevel, 'ultra');
  assert.match(agent.messages[0].content, /CAVEMAN MODE ACTIVE \(ultra\)/);

  agent.clearCavemanLevel();
  assert.equal(agent.cavemanLevel, null);
  assert.doesNotMatch(agent.messages[0].content, /CAVEMAN MODE ACTIVE/);
});
