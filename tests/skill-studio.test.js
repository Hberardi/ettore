import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillSubmission, renderSkillStudioPage } from '../src/web/skill-studio.js';

test('skill studio page exposes the three global skill fields', () => {
  const page = renderSkillStudioPage();
  assert.match(page, /id="name"/);
  assert.match(page, /id="purpose"/);
  assert.match(page, /id="output"/);
  assert.match(page, /Create global skill/);
});

test('skill studio validates and normalizes submitted data', () => {
  assert.deepEqual(parseSkillSubmission({
    name: 'API-Review',
    purpose: ' Review API contracts ',
    output: ' Findings by severity ',
  }), {
    name: 'api-review',
    purpose: 'Review API contracts',
    output: 'Findings by severity',
  });
  assert.throws(() => parseSkillSubmission({ name: 'api-review', purpose: '', output: 'report' }), /what the skill should do/);
  assert.throws(() => parseSkillSubmission({ name: 'api-review', purpose: 'review', output: '' }), /expected final output/);
});
