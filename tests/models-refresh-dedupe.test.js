import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConnectionManager } from '../src/providers/index.js';

// A provider loaded from the environment starts with no fetch time, and boot
// reads its model list from several places at once. Each read used to start
// its own /models request — four round trips and four "Refreshed" lines.
test('concurrent refreshes of one provider share a single /models request', async () => {
  let listCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const em = new EventEmitter();
  const mgr = new ConnectionManager();
  mgr.connections.set('stub', {
    provider: {
      listModels: async () => {
        listCalls++;
        await gate;
        return { success: true, models: [{ id: 'a' }, { id: 'b' }] };
      },
    },
    key: 'k', baseUrl: null, valid: true, models: [], modelsFetchedAt: 0,
  });
  mgr.setEmitter(em);
  const events = [];
  em.on('modelsRefreshed', e => events.push(e));

  // What boot does: listModels() from several callers before any fetch lands.
  mgr.listModels('stub');
  mgr.listModels('stub');
  const direct = mgr.refreshModels('stub');
  mgr.listModels('stub');
  release();
  const result = await direct;

  assert.equal(result.success, true);
  assert.equal(listCalls, 1, 'one network request, not one per caller');
  assert.equal(events.length, 1, 'one "Refreshed" line');
});

test('a refresh after the shared one finished runs again when forced', async () => {
  let listCalls = 0;
  const mgr = new ConnectionManager();
  mgr.connections.set('stub', {
    provider: { listModels: async () => { listCalls++; return { success: true, models: [{ id: 'a' }] }; } },
    key: 'k', baseUrl: null, valid: true, models: [], modelsFetchedAt: 0,
  });
  await mgr.refreshModels('stub');
  await mgr.refreshModels('stub', { force: true });
  assert.equal(listCalls, 2, 'dedupe only joins requests in flight; it never caches a finished one');
});
