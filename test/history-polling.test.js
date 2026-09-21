import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPoller, HISTORY_REFRESH_MS } from '../public/history-polling.js';

test('range changes bypass the interval and coalesce while a request is in flight', async () => {
  let key = '24h', release, time = 0;
  const calls = [];
  const poller = createHistoryPoller(range => {
    calls.push(range);
    return new Promise(resolve => { release = resolve; });
  }, () => false, () => time, () => key);
  const first = poller.refresh();
  key = '7d'; await poller.refresh();
  key = '24h'; await poller.refresh();
  key = '7d'; await poller.refresh();
  assert.deepEqual(calls, ['24h']);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['24h', '7d']);
  release(); await first;
  await poller.refresh(); assert.equal(calls.length, 2);
  time = HISTORY_REFRESH_MS - 1;
  await poller.refresh(); assert.equal(calls.length, 2);
  key = '24h';
  const changed = poller.refresh();
  assert.deepEqual(calls, ['24h', '7d', '24h']);
  release(); await changed;
});

test('a range changed while hidden is fetched on return even inside the interval', async () => {
  let key = '24h', hidden = false;
  const calls = [];
  const poller = createHistoryPoller(async range => calls.push(range), () => hidden, () => 0, () => key);
  await poller.refresh();
  hidden = true; key = '7d'; await poller.refresh();
  assert.deepEqual(calls, ['24h']);
  hidden = false; await poller.refresh();
  assert.deepEqual(calls, ['24h', '7d']);
});

test('history polls at five-minute intervals, pauses hidden tabs and refreshes when overdue', async () => {
  let time = 0, hidden = true, calls = 0;
  const poller = createHistoryPoller(async () => { calls++; }, () => hidden, () => time);
  await poller.refresh(); assert.equal(calls, 0);
  hidden = false; await poller.refresh(); assert.equal(calls, 1);
  time = HISTORY_REFRESH_MS - 1; await poller.refresh(); assert.equal(calls, 1);
  hidden = true; time = HISTORY_REFRESH_MS; await poller.refresh(); assert.equal(calls, 1);
  hidden = false; await poller.refresh(); assert.equal(calls, 2);
  hidden = true; await poller.refresh(); hidden = false; await poller.refresh(); assert.equal(calls, 2);
});

test('slow and failed requests cannot cause concurrent calls or rapid retries', async () => {
  let time = 0, calls = 0, release;
  const poller = createHistoryPoller(() => { calls++; return new Promise(resolve => { release = resolve; }); }, () => false, () => time);
  const pending = poller.refresh(); time = HISTORY_REFRESH_MS;
  await poller.refresh(); assert.equal(calls, 1);
  release(); await pending;
  const next = poller.refresh(); assert.equal(calls, 2); release(); await next;
  let failures = 0;
  const failed = createHistoryPoller(async () => { failures++; throw new Error('offline'); }, () => false, () => time);
  await assert.rejects(failed.refresh(), /offline/);
  await failed.refresh(); assert.equal(failures, 1);
  time += HISTORY_REFRESH_MS; await assert.rejects(failed.refresh(), /offline/); assert.equal(failures, 2);
});
