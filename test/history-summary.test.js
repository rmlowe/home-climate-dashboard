import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { summarizeMetric } from '../public/history-summary.js';
import { summaryWindow } from '../src/history-tools.js';
import worker from '../src/index.js';

const slot = 300_000, day = 86_400_000;
const now = Date.UTC(2026, 8, 26, 8);
const point = (time, temperature = 20, humidity = 45, online = true) => ({
  collectedAt: time, scheduledAt: time, temperature, humidity, online,
});
const window = { from: 0, to: 6 * slot, intervalMs: slot };

test('summary preserves zeros, treats metrics independently and never fills gaps', () => {
  const points = [point(-1, 100), point(0, 0, 0), point(slot, 10, null),
    point(2 * slot, 80, 80, false), point(3 * slot, 90, 90, null), point(5 * slot, 20, 60), point(6 * slot, 100)];
  const t = summarizeMetric(points, 'temperature', window);
  assert.deepEqual(t, { samples: 3, min: 0, max: 20, mean: 10, first: 0, last: 20, change: 20,
    firstCollectedAt: 0, lastCollectedAt: 5 * slot, observedPeriods: 3, expectedPeriods: 6, coveragePercent: 50, longestMissingRun: 3 });
  const h = summarizeMetric(points, 'humidity', window);
  assert.equal(h.samples, 2); assert.equal(h.mean, 30); assert.equal(h.longestMissingRun, 4);
  assert.ok(Math.abs(h.coveragePercent - 100 / 3) < 1e-10);
});

test('replayed slots cannot inflate coverage and chronology follows collection time', () => {
  const points = [point(5 * slot, 25), { ...point(1000, 20), scheduledAt: -day },
    { ...point(2000, 22), scheduledAt: -2 * day }];
  const summary = summarizeMetric(points, 'temperature', window);
  assert.equal(summary.samples, 3); assert.equal(summary.observedPeriods, 2);
  assert.equal(summary.change, 5); assert.equal(summary.firstCollectedAt, 1000);
  assert.equal(summary.lastCollectedAt, 5 * slot);
});

test('empty, invalid and single samples have no invented values or changes', () => {
  const empty = summarizeMetric([point(slot, NaN), point(2 * slot, Infinity)], 'temperature', window);
  for (const name of ['min', 'max', 'mean', 'first', 'last', 'change', 'firstCollectedAt', 'lastCollectedAt']) assert.equal(empty[name], null);
  assert.equal(empty.coveragePercent, 0); assert.equal(empty.longestMissingRun, 6);
  const single = summarizeMetric([point(slot, 0)], 'temperature', window);
  assert.equal(single.mean, 0); assert.equal(single.change, null);
  const simultaneous = summarizeMetric([point(slot, 1), { ...point(slot, 2), scheduledAt: 0 }], 'temperature', window);
  assert.equal(simultaneous.change, null);
});

test('partial edge periods use the same denominator as observed UTC periods', () => {
  const summary = summarizeMetric([point(1000), point(slot), point(2 * slot)], 'temperature', {
    from: 1000, to: 2 * slot + 1000, intervalMs: slot,
  });
  assert.equal(summary.expectedPeriods, 3); assert.equal(summary.coveragePercent, 100);
});

test('window defaults, seven-day boundary and timezone offsets are explicit', () => {
  assert.deepEqual(summaryWindow({}, now), { from: now - day, to: now });
  const args = { from: '2026-09-25T23:00:00+01:00', to: '2026-09-26T08:00:00+01:00' };
  assert.deepEqual(summaryWindow(args, now), { from: Date.UTC(2026, 8, 25, 22), to: Date.UTC(2026, 8, 26, 7) });
  assert.equal(summaryWindow({ from: new Date(now - 7 * day).toISOString(), to: new Date(now).toISOString() }, now).from, now - 7 * day);
  // The caller resolves the London DST transition using explicit offsets: nine elapsed hours.
  const dstNow = Date.UTC(2026, 9, 25, 10);
  const dst = summaryWindow({ from: '2026-10-25T00:00:00+01:00', to: '2026-10-25T08:00:00+00:00' }, dstNow);
  assert.equal(dst.to - dst.from, 9 * 3_600_000);
  for (const args of [{ from: new Date(now).toISOString() }, { to: new Date(now).toISOString() },
    { from: 'bad', to: 'bad' }, { from: new Date(now - 7 * day - 1).toISOString(), to: new Date(now).toISOString() },
    { from: new Date(now).toISOString(), to: new Date(now).toISOString() },
    { from: new Date(now - day).toISOString(), to: new Date(now + 1).toISOString() }]) {
    assert.throws(() => summaryWindow(args, now));
  }
});

const token = 'history-test-token-with-at-least-32-characters';
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_readings.sql', '0002_collection_time_index.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  let queries = 0;
  return { get queries() { return queries; }, prepare(sql) {
    queries++;
    const stmt = sqlite.prepare(sql);
    const bound = args => ({ async all() { return { results: stmt.all(...args) }; } });
    return { ...bound([]), bind: (...args) => bound(args) };
  }, insert(id, time, temp = 22, humidity = 45, online = 1, name = 'Bedroom', scheduled = time) {
    sqlite.prepare('INSERT INTO readings VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scheduled, time, name, temp, humidity, online);
  } };
}
async function rpc(DB, name, args = {}, auth = token) {
  const response = await worker.fetch(new Request('http://localhost/mcp', {
    method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), { DB, MCP_AUTH_TOKEN: token }, {});
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  if (response.status !== 200) return { status: response.status };
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find(line => line.startsWith('data:')).slice(5) : text);
}
function noSensorFetch(t) {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('History must not poll upstream sensors'); });
  t.mock.method(Date, 'now', () => now);
}

test('MCP custom summary uses D1 with bounded windows, stable IDs and matching text/structured output', async t => {
  noSensorFetch(t);
  const DB = database(t);
  DB.insert('secret-device', now - 12 * slot, 18, 40, 1, 'Old name');
  DB.insert('secret-device', now - 11 * slot, 20, null, 1, 'Bedroom');
  DB.insert('secret-device', now - slot, 30, 80);
  DB.insert('other-device', now - 11 * slot, 22, 50); // Duplicate room names are distinct.
  const from = now - 12 * slot, to = now - 10 * slot;
  const response = await rpc(DB, 'get_history_summary', { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  assert.ok(!response.error); assert.notEqual(response.result.isError, true);
  const data = response.result.structuredContent;
  assert.equal(data.from, from); assert.equal(data.to, to);
  const room = data.rooms.find(r => r.temperature.samples === 2);
  assert.equal(room.temperature.mean, 19); assert.equal(room.temperature.change, 2);
  assert.equal(room.humidity.coveragePercent, 50); assert.equal(room.humidity.change, null);
  assert.equal(room.name, 'Bedroom'); assert.notEqual(data.rooms[0].id, data.rooms[1].id);
  assert.doesNotMatch(JSON.stringify(data), /secret-device|other-device/);
  assert.deepEqual(JSON.parse(response.result.content[0].text), data);
});

test('MCP health distinguishes stale collection from recent offline/incomplete readings', async t => {
  noSensorFetch(t);
  const DB = database(t);
  DB.insert('stopped', now - 2 * day);
  DB.insert('offline', now - 2 * slot, 21, 45);
  DB.insert('offline', now - slot, null, null, 0, 'Offline');
  DB.insert('incomplete', now - slot, 23, null, 1, 'Incomplete');
  DB.insert('unknown', now - slot, null, null, null, 'Unknown');
  const response = await rpc(DB, 'get_collection_health');
  assert.notEqual(response.result.isError, true);
  const data = response.result.structuredContent;
  assert.equal(data.collectionStatus, 'some_rooms_stale');
  const stopped = data.rooms.find(r => r.collectionStale);
  assert.equal(stopped.temperature.samples, 0); assert.equal(stopped.temperature.coveragePercent, 0);
  assert.equal(stopped.lastCollectedAt, now - 2 * day); assert.equal(stopped.validReadingStale, true);
  const offline = data.rooms.find(r => r.name === 'Offline');
  assert.equal(offline.collectionStale, false); assert.equal(offline.lastReadingStatus, 'offline');
  assert.equal(offline.temperature.max, 21); assert.equal(offline.lastValidAt, now - 2 * slot);
  const incomplete = data.rooms.find(r => r.name === 'Incomplete');
  assert.equal(incomplete.lastReadingStatus, 'incomplete'); assert.equal(incomplete.lastValidAt, null);
  assert.equal(incomplete.temperature.samples, 1); assert.equal(incomplete.humidity.samples, 0);
  assert.equal(data.rooms.find(r => r.name === 'Unknown').lastReadingStatus, 'unknown');
  assert.deepEqual(JSON.parse(response.result.content[0].text), data);
});

test('empty history succeeds; missing/broken storage returns sanitized tool errors', async t => {
  noSensorFetch(t);
  const DB = database(t);
  for (const tool of ['get_history_summary', 'get_collection_health']) {
    const empty = (await rpc(DB, tool)).result;
    assert.deepEqual(empty.structuredContent.rooms, []);
    if (tool === 'get_collection_health') assert.equal(empty.structuredContent.collectionStatus, 'no_data');
    for (const broken of [undefined, { prepare() { throw new Error('private SQL and device secret'); } }]) {
      const failure = (await rpc(broken, tool)).result;
      assert.equal(failure.isError, true);
      assert.doesNotMatch(JSON.stringify(failure), /private SQL|device secret/);
    }
  }
});

test('invalid arguments and unauthorized calls never read D1', async t => {
  noSensorFetch(t);
  const DB = database(t);
  for (const args of [{ from: '2026-09-25T23:00:00' }, { from: '2026-09-25T23:00:00Z' },
    { room: 'Bedroom' }, { from: '2026-09-25T23:00:00Z', to: '2026-09-27T08:00:00Z' },
    { from: '2026-09-18T23:00:00Z', to: '2026-09-26T08:00:00Z' },
    { from: '2026-09-26T08:00:00Z', to: '2026-09-25T23:00:00Z' }]) {
    const response = await rpc(DB, 'get_history_summary', args);
    assert.ok(response.error || response.result?.isError);
  }
  for (const tool of ['get_history_summary', 'get_collection_health']) {
    assert.equal((await rpc(DB, tool, {}, 'wrong')).status, 401);
  }
  assert.equal(DB.queries, 0);
});
