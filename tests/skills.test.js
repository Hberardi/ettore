import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SkillSystem,
  createProjectSkill,
  renderSkillMarkdown,
  validateSkillName,
} from '../src/skills/index.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'ettore-skills-'));
}

test('skill markdown has a safe project-local format', async () => {
  const root = await tempDir();
  try {
    assert.equal(validateSkillName('api-review'), 'api-review');
    assert.throws(() => validateSkillName('../escape'), /kebab-case/);
    const path = await createProjectSkill(
      root,
      'api-review',
      'Review REST API changes',
      'Check compatibility and regression risks.',
      'Return findings grouped by severity.',
    );
    const content = await readFile(path, 'utf8');
    assert.match(content, /name: api-review/);
    assert.match(content, /description: Review REST API changes/);
    assert.match(content, /## What to do\nCheck compatibility and regression risks\./);
    assert.match(content, /## Final output\nReturn findings grouped by severity\./);
    await assert.rejects(() => createProjectSkill(root, 'api-review', 'duplicate'), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skill system loads project skills and matches meaningful triggers', async () => {
  const root = await tempDir();
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
      'Check request validation, response compatibility, and regression tests.',
      '',
    ].join('\n'));

    const system = new SkillSystem();
    await system.loadAllSkills({ projectDir: root, global: false });
    assert.ok(system.getSkill('code'));
    const matches = system.matchSkills('Review the OpenAPI endpoint contract');
    assert.deepEqual(matches.map(skill => skill.name), ['api-review']);
    assert.match(system.getPromptForSkills(matches), /ACTIVE SKILL: api-review/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
