import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStreamingSignal } from '../src/llm/client.js';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Before the first token the wait is the provider's queue: NVIDIA's hosted
// Nemotron 3 Ultra took 58-78s there. The idle window used to run from the
// request itself, so a queue longer than it aborted a reply on its way.
test('the first token may take longer than the idle window', async () => {
  const watch = makeStreamingSignal(null, 40, 200);
  try {
    await sleep(100);
    assert.equal(watch.signal.aborted, false, 'still inside the first-token window');
    watch.resetTimer(); // first token arrived: from now on the idle window applies
    await sleep(90);
    assert.equal(watch.signal.aborted, true, 'a stall after the first token is still cut off');
    assert.match(String(watch.signal.reason?.message), /idle timeout/);
  } finally {
    watch.clear();
  }
});

test('a provider that never sends anything is cut off, and told apart from a stall', async () => {
  const watch = makeStreamingSignal(null, 20, 60);
  try {
    await sleep(120);
    assert.equal(watch.signal.aborted, true);
    assert.match(String(watch.signal.reason?.message), /sent nothing for 0\.06s \(queued or overloaded\)/);
  } finally {
    watch.clear();
  }
});

test('a parent abort still wins immediately', async () => {
  const parent = new AbortController();
  const watch = makeStreamingSignal(parent.signal, 1000, 5000);
  parent.abort(new Error('user cancelled'));
  assert.equal(watch.signal.aborted, true);
  assert.match(String(watch.signal.reason?.message), /user cancelled/);
  watch.clear();
});
