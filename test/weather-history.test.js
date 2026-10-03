import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { archiveWeather, readOutdoorHistory } from '../src/weather-history.js';
import { compareRoomHistory, dewPoint } from '../public/comparison-summary.js';
import worker from '../src/index.js';

const hour = 3_600_000, now = Date.UTC(2026, 9, 3, 12);
function environment(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_readings.sql', '0002_collection_time_index.sql', '0003_weather_cache.sql', '0004_weather_history.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = args => ({ async all() { return { results: statement.all(...args) }; },
        async first() { return statement.get(...args) ?? null; }, async run() { return statement.run(...args); } });
      return { ...bound([]), bind: (...args) => bound(args) };
    },
    async batch(statements) { return Promise.all(statements.map(s => s.run())); },
  };
  return { env: { DB, WEATHER_LATITUDE: '51.61', WEATHER_LONGITUDE: '-0.21' }, sqlite };
}
const point = (time, temperature = 20, humidity = 50, online = true) => ({ collectedAt: time, temperature, humidity, online });
const weather = (time, temperature = 10, humidity = 60) => ({ validAt: time, temperature, humidity });

test('archive persists beyond cache, isolates locations, rejects future/non-hour points and tolerates retries', async t => {
  const { env } = environment(t);
  const old = now - 6 * 24 * hour;
  const data = { fetchedAt: old + hour, points: [weather(old, 0, 0), weather(old + 1), weather(old + 2 * hour)] };
  await archiveWeather(env.DB, '51.61,-0.21', data);
  await archiveWeather(env.DB, '51.61,-0.21', data);
  await archiveWeather(env.DB, '0,0', { ...data, points: [weather(old, 40)] });
  await env.DB.prepare('DELETE FROM weather_cache').run();
  const result = await readOutdoorHistory(env, old, now);
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].temperature, 0);
  assert.equal(result.points[0].humidity, 0);
  assert.equal(result.points[0].fetchedAt, old + hour);
  // Newer model revisions win; delayed older writes cannot overwrite them.
  await archiveWeather(env.DB, '51.61,-0.21', { fetchedAt: old + 2 * hour, points: [weather(old, 5)] });
  await archiveWeather(env.DB, '51.61,-0.21', data);
  assert.equal((await readOutdoorHistory(env, old, now)).points[0].temperature, 5);
  assert.equal((await readOutdoorHistory({ ...env, WEATHER_LATITUDE: '52' }, old, now)).points.length, 0);
});

test('hourly pairing weights hours equally, excludes offline/boundary samples and does not bridge gaps', () => {
  const from = now - 4 * hour, to = now;
  const room = { id: 'opaque', name: 'Bedroom', points: [point(from, 20), point(from + 1000, 24),
    point(from + hour, 100, 50, false), point(from + 2 * hour, 26), point(from + 3 * hour, 30), point(to, 100)] };
  const outside = { points: [weather(from, 10), weather(from + hour, 12), weather(from + 3 * hour, 20), weather(to, 90)] };
  const result = compareRoomHistory(room, outside, { from, to });
  assert.equal(result.temperature.indoor.mean, 26); // mean of 22 and 30, not three raw samples
  assert.equal(result.temperature.indoor.change, 8);
  assert.equal(result.temperature.outdoor.change, 10);
  assert.equal(result.temperature.difference.mean, 11);
  assert.equal(result.temperature.difference.coveragePercent, 50);
  assert.equal(result.temperature.difference.longestMissingRun, 2);
  assert.equal(result.temperature.availableIndoorHours, 3);
  assert.equal(result.temperature.availableOutdoorHours, 3);
});

test('partial edge hour uses only indoor samples inside window and preserves zero temperature', () => {
  const from = now - hour + 1000, to = now + 1000;
  const result = compareRoomHistory({ points: [point(from - 1, 100), point(from, 0, 0), point(to, 100)] },
    { points: [weather(now - hour, 0, 50)] }, { from, to });
  assert.equal(result.temperature.difference.mean, 0);
  assert.equal(result.temperature.difference.expectedPeriods, 2);
  assert.equal(result.temperature.difference.change, null);
  assert.equal(result.dewPoint.difference.hours, 0);
  assert.equal(result.dewPoint.difference.mean, null);
});

test('dew point uses both metrics; equal RH at different temperatures is not equal moisture', () => {
  assert.ok(Math.abs(dewPoint(20, 50) - 9.26) < 0.02);
  assert.equal(dewPoint(0, 100), 0);
  assert.ok(dewPoint(25, 50) > dewPoint(10, 50));
  for (const [t, h] of [[20, 0], [20, null], [null, 50], [20, 101], [20, -1]]) assert.equal(dewPoint(t, h), null);
});

const token = 'history-comparison-test-token-123456789';
async function rpc(env, args = {}) {
  const response = await worker.fetch(new Request('http://localhost/mcp', {
    method: 'POST', headers: { Host: 'localhost', 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_history_comparison', arguments: args } }),
  }), { ...env, MCP_AUTH_TOKEN: token }, {});
  assert.equal(response.status, 200);
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find(line => line.startsWith('data:')).slice(5) : text);
}

test('MCP schema validates populated and empty comparison results without upstream calls', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const { env, sqlite } = environment(t);
  sqlite.prepare('INSERT INTO readings VALUES (?, ?, ?, ?, ?, ?, ?)').run('private-device', now - hour, now - hour, 'Bedroom', 20, 50, 1);
  const empty = (await rpc(env)).result;
  assert.notEqual(empty.isError, true);
  assert.equal(empty.structuredContent.outdoor.storedHours, 0);
  assert.equal(empty.structuredContent.rooms[0].temperature.difference.mean, null);
  await archiveWeather(env.DB, '51.61,-0.21', { fetchedAt: now, points: [weather(now - hour)] });
  const result = (await rpc(env)).result;
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.rooms[0].temperature.difference.mean, 10);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.doesNotMatch(JSON.stringify(result), /private-device/);
  const dashboard = await (await worker.fetch(new Request('http://localhost/api/history?range=7d'), env)).json();
  assert.equal(dashboard.outdoor.points.length, 1);
  assert.equal(dashboard.outdoor.points[0].validAt, now - hour);
  assert.equal(dashboard.outdoor.points[0].fetchedAt, now);
  // Storage failure is distinct from an empty archive; indoor dashboard still works.
  sqlite.exec('DROP TABLE weather_history');
  assert.equal((await rpc(env)).result.isError, true);
  const partial = await (await worker.fetch(new Request('http://localhost/api/history'), env)).json();
  assert.equal(partial.rooms.length, 1);
  assert.equal(partial.outdoor.available, false);
});

test('MCP rejects missing offsets, half windows, future/oversize windows and unknown arguments', async t => {
  t.mock.method(Date, 'now', () => now);
  const { env } = environment(t);
  for (const args of [{ from: new Date(now - hour).toISOString() }, { extra: true },
    { from: '2026-10-03T10:00:00', to: '2026-10-03T11:00:00' },
    { from: new Date(now - hour).toISOString(), to: new Date(now + 1).toISOString() },
    { from: new Date(now - 8 * 24 * hour).toISOString(), to: new Date(now).toISOString() }]) {
    const result = await rpc(env, args);
    assert.ok(result.error || result.result?.isError);
  }
});
