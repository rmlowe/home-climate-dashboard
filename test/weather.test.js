import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { parseWeather, readWeather, weatherLocation, handleWeather } from '../src/weather.js';
import { outdoorSegments, weatherFresh } from '../public/weather-model.js';
import worker from '../src/index.js';
const now = Date.UTC(2026, 8, 12, 15);
const hour = 3_600_000;
function fixture(time = now) {
  const units = { time: 'unixtime', temperature_2m: '°C', relative_humidity_2m: '%' };
  return { current_units: units, hourly_units: units,
    current: { time: time / 1000, temperature_2m: 18, relative_humidity_2m: 65 },
    hourly: { time: [(time - hour) / 1000, time / 1000, (time + hour) / 1000],
      temperature_2m: [17, 18, 19], relative_humidity_2m: [70, 65, 60] } };
}
function environment(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0003_weather_cache.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return { WEATHER_LATITUDE: '51.61', WEATHER_LONGITUDE: '-0.21', WEATHER_LOCATION_NAME: 'Mill Hill East', DB: {
    prepare(sql) { const statement = sqlite.prepare(sql);
      return { bind(...args) { return { async first() { return statement.get(...args) ?? null; },
        async run() { return statement.run(...args); } }; } }; }
  } };
}

test('weather parser uses valid time, preserves zero/null, excludes future hours', () => {
  const body = fixture(); body.hourly.temperature_2m = [0, null, 19];
  body.hourly.relative_humidity_2m = [0, 101, 60];
  const result = parseWeather(body, now + 20_000);
  assert.equal(result.fetchedAt, now + 20_000);
  assert.equal(result.current.validAt, now);
  assert.deepEqual(result.points.map(p => [p.temperature, p.humidity]), [[0, 0], [null, null]]);
});

test('weather parser rejects malformed times, mismatched arrays and incorrect units', () => {
  for (const mutate of [b => b.current.time = 'bad', b => b.hourly.time.push(0),
    b => b.current_units = { ...b.current_units, temperature_2m: '°F' }, b => b.current.time += 3600]) {
    const body = fixture(); mutate(body); assert.throws(() => parseWeather(body, now));
  }
});

test('shared cache fetches at most every 15 minutes and keeps timestamps separate', async t => {
  const env = environment(t); let calls = 0;
  const fetcher = async url => {
    calls++; const u = new URL(url);
    assert.equal(u.hostname, 'api.open-meteo.com'); assert.equal(u.searchParams.get('timeformat'), 'unixtime');
    assert.equal(u.searchParams.get('latitude'), '51.61');
    return Response.json(fixture());
  };
  const first = await readWeather(env, now + 1000, fetcher);
  assert.equal(first.current.validAt, now); assert.equal(first.fetchedAt, now + 1000);
  await Promise.all([readWeather(env, now + 2000, fetcher), readWeather(env, now + 3000, fetcher)]);
  assert.equal(calls, 1);
  await readWeather(env, now + 15 * 60_000 + 1000, fetcher); assert.equal(calls, 2);
});

test('upstream failure keeps stale data and rate-limits retries', async t => {
  const env = environment(t);
  await readWeather(env, now, async () => Response.json(fixture()));
  let calls = 0;
  const fail = async () => { calls++; return new Response('', { status: 503 }); };
  const cached = await readWeather(env, now + hour, fail);
  assert.equal(cached.fetchedAt, now); assert.equal(cached.stale, true); assert.equal(cached.refreshFailed, true);
  assert.equal(weatherFresh(cached, now + hour), false);
  await readWeather(env, now + hour + 1000, fail); assert.equal(calls, 1);
});

test('cold-cache failure is unavailable, and changing location does not reuse old data', async t => {
  const env = environment(t); let calls = 0;
  const fail = async () => { calls++; throw new Error('offline'); };
  await assert.rejects(readWeather(env, now, fail), /not available/);
  await assert.rejects(readWeather(env, now + 1000, fail), /not available/); assert.equal(calls, 1);
  await readWeather(env, now + hour, async () => Response.json(fixture(now + hour)));
  await assert.rejects(readWeather({ ...env, WEATHER_LATITUDE: '52' }, now + hour, fail), /not available/);
});

test('current weather freshness ages without a network response', () => {
  const data = parseWeather(fixture(), now);
  assert.equal(weatherFresh(data, now), true);
  assert.equal(weatherFresh(data, now + 46 * 60_000), false);
  assert.equal(weatherFresh({ ...data, fetchedAt: now + hour }, now + hour + 1), false);
});

test('outdoor lines use hourly valid timestamps and break on missing/null values', () => {
  const points = [0, 1, 3, 4, 5].map(i => ({ validAt: now + i * hour, temperature: i === 4 ? null : i }));
  const runs = outdoorSegments(points, 'temperature', now, now + 5 * hour);
  assert.deepEqual(runs.map(r => r.length), [2, 1, 1]);
  assert.equal(runs[0][0].collectedAt, now);
  assert.deepEqual(outdoorSegments(points, 'temperature', now + hour, now + hour).flat().map(p => p.temperature), [1]);
});

test('weather route validates requests and fails separately from sensor storage', async () => {
  assert.equal((await handleWeather(new Request('https://app/api/weather', { method: 'POST' }), {})).status, 405);
  assert.equal((await handleWeather(new Request('https://app/api/weather?latitude=1'), {})).status, 400);
  const response = await worker.fetch(new Request('https://app/api/weather'), {});
  assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  for (const value of ['', 'NaN', '91']) assert.throws(() => weatherLocation({ WEATHER_LATITUDE: value, WEATHER_LONGITUDE: '0' }));
});

test('scheduled weather still runs when Govee fails', async t => {
  // Keep the request start and mock weather time on the same deterministic clock.
  t.mock.method(Date, 'now', () => now);
  const env = environment(t);
  const original = globalThis.fetch; let weatherCalls = 0;
  globalThis.fetch = async () => { weatherCalls++; return Response.json(fixture(now)); };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(worker.scheduled({ scheduledTime: now }, env));
  assert.equal(weatherCalls, 1);
  const cached = await readWeather(env);
  assert.equal(cached.current.temperature, 18);
  assert.equal(cached.current.validAt, now);
  assert.equal(cached.fetchedAt, now);
});
