import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { Agent } from '../src/agents/index.js';

test('Agent activates a matching project skill in the system prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ettore-agent-skills-'));
  try {
    const skillDir = join(root, '.ettore', 'skills', 'api-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      'name: api-review',
      'description: Review REST API endpoints and contracts',
      'triggers: endpoint, openapi, contract',
      '---',
      '',
      'Always check validation, compatibility, and focused regression tests.',
      '',
    ].join('\n'));

    let seenMessages = [];
    const client = {
      async turn(messages) {
        seenMessages = messages;
        return { type: 'text', content: 'done' };
      },
    };
    const agent = new Agent(client, {
      provider: 'test',
      model: 'test-model',
      modelCapability: 'full',
      workdir: root,
      contextWindow: 128000,
      verifyAfterEdit: false,
      skillsGlobal: false,
    });

    await agent.run('Review the OpenAPI endpoint contract', new EventEmitter());
    assert.match(String(seenMessages[0]?.content || ''), /ACTIVE SKILL: api-review/);
    assert.match(String(seenMessages[0]?.content || ''), /focused regression tests/);
    assert.deepEqual(agent.workingMemory.activeSkills, ['api-review']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
