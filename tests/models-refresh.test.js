import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConnectionManager } from '../src/providers/index.js';

// Build a ConnectionManager with all provider I/O stubbed so we can drive
// refresh behavior in isolation. We inject a fake providers registry by
// monkey-patching the connection entry directly.
//
// IMPORTANT: we construct the manager WITHOUT an emitter, then attach the
// emitter after the initial loadSavedConnections boot refresh. Otherwise the
// boot refresh would emit events that pollute event-count assertions.
function buildManager({ initialAgeMs = null, fetchOk = true, fetchedModels = [{ id: 'm1' }, { id: 'm2' }], emitter = null } = {}) {
  const mgr = new ConnectionManager();
  // Make sure the stub provider is registered with a fresh boot fetch that
  // doesn't reach a real network — we override the provider instance
  // entirely.
  mgr.connections.set('stub', {
    provider: {
      listModels: async () => fetchOk
        ? { success: true, models: fetchedModels }
        : { success: false, error: 'fetch failed' },
    },
    key: 'k',
    baseUrl: null,
    valid: true,
    models: [],
    modelsFetchedAt: initialAgeMs == null ? 0 : Date.now() - initialAgeMs,
  });
  if (emitter) mgr.setEmitter(emitter);
  return { mgr, em: emitter };
}

test('refreshModels emits modelsRefreshed on success with count and age', async () => {
  let listCalls = 0;
  const em = new EventEmitter();
  const mgr = new ConnectionManager();
  mgr.connections.set('stub', {
    provider: { listModels: async () => { listCalls++; return { success: true, models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }; } },
    key: 'k', baseUrl: null, valid: true, models: [], modelsFetchedAt: Date.now() - 120_000,
  });
  mgr.setEmitter(em);
  const events = [];
  em.on('modelsRefreshed', (e) => events.push(e));
  const r = await mgr.refreshModels('stub', { force: true });
  assert.equal(r.success, true);
  assert.equal(listCalls, 1, 'listModels must have been called (forced)');
  assert.equal(events.length, 1);
  assert.equal(events[0].provider, 'stub');
  assert.equal(events[0].count, 3);
  assert.ok(events[0].ageMs >= 120_000);
  assert.equal(events[0].forced, true);
});

test('refreshModels skips the network call and the emit when the cache is fresh', async () => {
  let listCalls = 0;
  const em = new EventEmitter();
  const mgr = new ConnectionManager();
  mgr.connections.set('stub', {
    provider: { listModels: async () => { listCalls++; return { success: true, models: [{ id: 'a' }] }; } },
    key: 'k', baseUrl: null, valid: true, models: [{ id: 'a' }], modelsFetchedAt: Date.now() - 1_000,
  });
  mgr.setEmitter(em);
  const events = [];
  em.on('modelsRefreshed', (e) => events.push(e));
  const r = await mgr.refreshModels('stub');
  assert.equal(r.success, true);
  assert.equal(r.refreshed, false);
  assert.equal(listCalls, 0, 'listModels must NOT be called when cache is fresh');
  assert.equal(events.length, 0, 'no emit when cache was fresh');
});

test('refreshModels does NOT emit on failure (and reports the error)', async () => {
  const em = new EventEmitter();
  const mgr = new ConnectionManager();
  mgr.connections.set('stub', {
    provider: { listModels: async () => ({ success: false, error: 'fetch failed' }) },
    key: 'k', baseUrl: null, valid: true, models: [], modelsFetchedAt: 0,
  });
  mgr.setEmitter(em);
  const events = [];
  em.on('modelsRefreshed', (e) => events.push(e));
  const r = await mgr.refreshModels('stub', { force: true });
  assert.equal(r.success, false);
  assert.equal(events.length, 0);
});

test('getModelsCacheStatus reports ageMs, fetchedAt and stale flag per provider', () => {
  const { mgr } = buildManager({ initialAgeMs: 5 * 60 * 1000 + 1 });
  const rows = mgr.getModelsCacheStatus();
  const stub = rows.find(r => r.provider === 'stub');
  assert.ok(stub, 'stub provider must appear in status');
  assert.ok(stub.ageMs >= 5 * 60 * 1000);
  assert.match(stub.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stub.stale, true);
});

test('getModelsCacheStatus marks never-fetched providers as stale', () => {
  const { mgr } = buildManager({ initialAgeMs: null });
  const rows = mgr.getModelsCacheStatus();
  const stub = rows.find(r => r.provider === 'stub');
  assert.equal(stub.ageMs, null);
  assert.equal(stub.fetchedAt, null);
  assert.equal(stub.stale, true);
});

test('setEmitter wires the new emitter without leaking the old one', async () => {
  const { mgr } = buildManager();
  const oldEm = new EventEmitter();
  const newEm = new EventEmitter();
  let oldCount = 0, newCount = 0;
  oldEm.on('modelsRefreshed', () => oldCount++);
  newEm.on('modelsRefreshed', () => newCount++);
  mgr.setEmitter(oldEm);
  await mgr.refreshModels('stub', { force: true });
  assert.equal(oldCount, 1, 'old emitter received the first refresh');
  assert.equal(newCount, 0);
  mgr.setEmitter(newEm);
  await mgr.refreshModels('stub', { force: true });
  assert.equal(oldCount, 1, 'old emitter must NOT receive subsequent refreshes');
  assert.equal(newCount, 1);
});

test('ConnectionManager without an emitter still works (no throw)', async () => {
  const mgr = new ConnectionManager();
  mgr.connections.set('stub', {
    provider: { listModels: async () => ({ success: true, models: [{ id: 'x' }] }) },
    key: 'k', baseUrl: null, valid: true, models: [], modelsFetchedAt: 0,
  });
  const r = await mgr.refreshModels('stub', { force: true });
  assert.equal(r.success, true);
});
