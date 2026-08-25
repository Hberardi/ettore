import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionControl } from '../src/mission/index.js';

test('Mission Control aggregates a turn, parallel wave, files, and usage', () => {
  const mission = new MissionControl();
  mission.startTurn('Implement the feature');
  mission.setPlan({ goal: 'Implement the feature', steps: [{ title: 'Inspect' }, { title: 'Edit' }] });
  mission.setTodos(['Inspect', 'Edit']);
  mission.startWave({ index: 0, total: 1, tools: [{ name: 'read' }, { name: 'grep' }] });
  mission.toolStart({ id: 'a', name: 'read', args: { file_path: 'src/app.js' } });
  mission.toolStart({ id: 'b', name: 'grep' });
  mission.toolEnd({ id: 'a', name: 'read', output: 'ok' });
  mission.toolEnd({ id: 'b', name: 'grep', output: 'ok' });
  mission.endWave({ index: 0, total: 1 });
  mission.fileChanged({ type: 'edit', path: 'src/app.js' });
  mission.addUsage({ inputTokens: 100, outputTokens: 40 });
  mission.completeTodo(0);

  const snapshot = mission.snapshot();
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.tools.total, 2);
  assert.equal(snapshot.tools.completed, 2);
  assert.equal(snapshot.waves[0].tools.length, 2);
  assert.deepEqual(snapshot.files.map(file => file.path), ['src/app.js']);
  assert.equal(snapshot.usage.inputTokens, 100);
  assert.equal(snapshot.progress.todos, '1/2');

  mission.endTurn();
  assert.equal(mission.snapshot().status, 'completed');
  assert.match(mission.format(), /Files changed: 1/);
});

test('continuation keeps the same mission while a new user prompt starts a new one', () => {
  const mission = new MissionControl();
  mission.startTurn('First task');
  const firstId = mission.snapshot().id;
  mission.endTurn();
  mission.startTurn('Continue first task', { continuation: true });
  assert.equal(mission.snapshot().id, firstId);
  assert.equal(mission.snapshot().turns, 2);
  mission.endTurn();
  mission.startTurn('Second task');
  assert.notEqual(mission.snapshot().id, firstId);
  assert.equal(mission.snapshot().history.length, 1);
});
