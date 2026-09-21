import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readHistory } from '../src/history.js';
import worker from '../src/index.js';
import { segments, freshness } from '../public/chart.js';

const now = Date.UTC(2026, 8, 11, 21, 15);
const slot = 300_000;
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_readings.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_collection_time_index.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    const bound = args => ({
      async all() { return { results: statement.all(...args) }; },
      async first() { return statement.get(...args) ?? null; },
    });
    return { ...bound([]), bind: (...args) => bound(args) };
  }, insert(id, time, temp = 22, humidity = 45, online = 1, name = 'Office', collectedAt = time + 1000) {
    sqlite.prepare('INSERT INTO readings VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, time, collectedAt, name, temp, humidity, online);
  } };
}

test('24-hour history separates renamed and duplicate-name devices and retains nulls and zeros', async t => {
  const DB = database(t);
  DB.insert('private-govee-id', now - 2 * 86_400_000, 20, 40, 1, 'Old name');
  DB.insert('private-govee-id', now - 86_400_000, 0, 0);
  DB.insert('private-govee-id', now - 2 * slot, null, null, 0);
  DB.insert('private-govee-id', now - slot, 22, null);
  DB.insert('other-id', now - slot, 23, 48);
  const data = await readHistory(DB, now);
  assert.equal(data.rooms.length, 2);
  assert.equal(data.to - data.from, 86_400_000);
  const room = data.rooms.find(r => r.points.length === 3);
  assert.equal(room.name, 'Office');
  assert.equal(room.lastCollectedAt, now - slot + 1000);
  assert.equal(room.lastValidAt, now - 86_400_000 + 1000);
  assert.equal(room.points[0].temperature, 0);
  assert.equal(room.points[0].humidity, 0);
  assert.equal(room.points[1].online, false);
  assert.equal(room.points[1].temperature, null);
  assert.equal(room.points[2].humidity, null);
  assert.notEqual(data.rooms[0].id, data.rooms[1].id);
  assert.ok(!JSON.stringify(data).includes('private-govee-id'));
  assert.equal((await readHistory(DB, now)).rooms[0].id, data.rooms[0].id);
});

test('rooms with no recent data remain visible as stale; empty database is an empty success', async t => {
  const DB = database(t);
  assert.deepEqual((await readHistory(DB, now)).rooms, []);
  DB.insert('stopped', now - 3 * 86_400_000);
  DB.insert('never-valid', now - slot, null, null, null);
  const data = await readHistory(DB, now);
  const stopped = data.rooms.find(r => r.points.length === 0);
  assert.equal(freshness(stopped, now, data.staleAfterMs), 'Collection is stale');
  const invalid = data.rooms.find(r => r.points.length === 1);
  assert.equal(invalid.lastValidAt, null);
  assert.equal(freshness(invalid, now, data.staleAfterMs), 'Valid readings are stale');
});

test('history route handles method, range, missing DB and database failures without falling through to assets', async t => {
  const request = (suffix = '', method = 'GET') => new Request(`https://example.com/api/history${suffix}`, { method });
  const DB = database(t);
  const ok = await worker.fetch(request(), { DB });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await ok.json()).rooms, []);
  const post = await worker.fetch(request('', 'POST'), { DB });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET');
  assert.equal((await worker.fetch(request('?hours=9999'), { DB })).status, 400);
  assert.equal((await worker.fetch(request(), {})).status, 503);
  const broken = { prepare() { throw new Error('database failed'); } };
  const failed = await worker.fetch(request(), { DB: broken });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'Unable to retrieve history' });
});

test('chart paths split at missed slots and invalid metrics; valid zero and singletons remain visible', () => {
  const p = (i, temperature = 22, humidity = 45, online = true) => ({
    scheduledAt: i * slot, collectedAt: i * slot + 1000, temperature, humidity, online,
  });
  const points = [p(0, 0), p(1), p(3), p(4, null), p(5), p(6, null, null, false), p(7)];
  assert.deepEqual(segments(points, 'temperature', slot).map(r => r.length), [2, 1, 1, 1]);
  assert.deepEqual(segments(points, 'humidity', slot).map(r => r.length), [2, 3, 1]);
  assert.equal(segments([p(0, 0)], 'temperature', slot)[0][0].temperature, 0);
});

test('freshness ages loaded data and flags a new incomplete reading', () => {
  const room = { lastCollectedAt: now, lastValidAt: now, points: [] };
  assert.equal(freshness(room, now, 600_000), 'History is up to date');
  assert.equal(freshness(room, now + 600_001, 600_000), 'Collection is stale');
  room.points.push({ online: true, temperature: 20, humidity: null });
  assert.equal(freshness(room, now, 600_000), 'Latest reading is unavailable or incomplete');
});

test('collection-time range query uses the new index without a temporary sort', async t => {
  const DB = database(t);
  const plan = DB.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT * FROM readings
    WHERE device_id = ? AND collected_at >= ? AND collected_at <= ? ORDER BY collected_at, scheduled_at`)
    .all('sensor', now - 86_400_000, now);
  const detail = plan.map(r => r.detail).join(' ');
  assert.match(detail, /USING INDEX readings_device_collected_at/);
  assert.doesNotMatch(detail, /TEMP B-TREE/);
});

test('recent collection from a two-day-old slot appears in the history window', async t => {
  const DB = database(t);
  DB.insert('sensor', now - 2 * 86_400_000, 23, 46, 1, 'Office', now - 60_000);
  const { rooms: [room] } = await readHistory(DB, now);
  assert.equal(room.points.length, 1);
  assert.equal(room.points[0].collectedAt, now - 60_000);
  assert.equal(room.points[0].scheduledAt, now - 2 * 86_400_000);
});

test('metadata and points follow collection order when older slots are replayed', async t => {
  const DB = database(t);
  DB.insert('sensor', now - 2 * slot, 22, 45, 1, 'Old name', now - 2 * slot + 1000);
  DB.insert('sensor', now - 4 * slot, 23, 46, 1, 'New name', now - 60_000);
  let room = (await readHistory(DB, now)).rooms[0];
  assert.equal(room.name, 'New name');
  assert.equal(room.lastCollectedAt, now - 60_000);
  assert.equal(room.lastValidAt, now - 60_000);
  assert.deepEqual(room.points.map(p => p.collectedAt), [now - 2 * slot + 1000, now - 60_000]);
  DB.insert('sensor', now - 3 * slot, 24, null, 1, 'New name', now - 30_000);
  room = (await readHistory(DB, now)).rooms[0];
  assert.equal(room.lastCollectedAt, now - 30_000);
  assert.equal(room.lastValidAt, now - 60_000);
  assert.equal(freshness(room, now, 600_000), 'Latest reading is unavailable or incomplete');
});

test('collection-time boundaries are inclusive and future collections cannot supply metadata', async t => {
  const DB = database(t);
  const from = now - 86_400_000;
  DB.insert('sensor', from - 3 * slot, 21, 45, 1, 'Before', from - 1);
  DB.insert('sensor', from - 2 * slot, 22, 45, 1, 'Start', from);
  DB.insert('sensor', from - slot, 23, 45, 1, 'End', now);
  DB.insert('sensor', now - slot, 24, 45, 1, 'Future', now + 1);
  const { rooms: [room] } = await readHistory(DB, now);
  assert.deepEqual(room.points.map(p => p.collectedAt), [from, now]);
  assert.equal(room.name, 'End');
  assert.equal(room.lastCollectedAt, now);
  assert.equal(room.lastValidAt, now);
});

test('chart breaks on backwards scheduled slots and long collection gaps', () => {
  const p = (scheduledAt, collectedAt) => ({ scheduledAt, collectedAt, temperature: 22, online: true });
  const replay = [p(3 * slot, 4 * slot), p(slot, 5 * slot), p(2 * slot, 6 * slot)];
  assert.deepEqual(segments(replay, 'temperature', slot).map(run => run.length), [1, 2]);
  const delayed = [p(slot, slot), p(2 * slot, 8 * slot)];
  assert.deepEqual(segments(delayed, 'temperature', slot).map(run => run.length), [1, 1]);
});

test('seven-day history includes older readings and enforces its collection-time boundary', async t => {
  const DB = database(t);
  const from = now - 7 * 86_400_000;
  DB.insert('sensor', from - slot, 10, 40, 1, 'Office', from - 1);
  DB.insert('sensor', from, 11, 40, 1, 'Office', from);
  DB.insert('sensor', now - 3 * 86_400_000, 12);
  DB.insert('sensor', now - slot, 13);
  const week = await readHistory(DB, now, '7d');
  assert.equal(week.from, from);
  assert.deepEqual(week.rooms[0].points.map(p => p.temperature), [11, 12, 13]);
  assert.equal((await readHistory(DB, now)).rooms[0].points.length, 1);
  for (const range of ['24h', '7d']) {
    const response = await worker.fetch(new Request(`https://example.com/api/history?range=${range}`), { DB });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.to - body.from, (range === '7d' ? 7 : 1) * 86_400_000);
  }
  for (const query of ['range=', 'range=30d', 'range=7d&range=24h', 'range=7d&foo=1']) {
    assert.equal((await worker.fetch(new Request(`https://example.com/api/history?${query}`), { DB })).status, 400);
  }
});

test('device discovery seeks through existing indexes and retains empty IDs and stopped devices', async t => {
  const DB = database(t);
  for (const id of ['', 'a', 'a-longer', 'z']) {
    for (let i = 1; i <= 1000; i++) DB.insert(id, now - 3 * 86_400_000 - i * slot);
  }
  const queries = [];
  const wrapped = { prepare(sql) {
    queries.push(sql);
    return DB.prepare(sql);
  } };
  const data = await readHistory(wrapped, now);
  assert.equal(data.rooms.length, 4);
  assert.ok(data.rooms.every(room => room.points.length === 0));
  assert.equal(queries.filter(sql => sql.startsWith('SELECT device_id')).length, 5);
  assert.ok(queries.every(sql => !sql.includes('DISTINCT')));
  const plan = DB.sqlite.prepare('EXPLAIN QUERY PLAN SELECT device_id FROM readings WHERE device_id > ? ORDER BY device_id LIMIT 1').all('a');
  assert.match(plan.map(r => r.detail).join(' '), /SEARCH .* USING COVERING INDEX .*device_id>\?/);
  assert.doesNotMatch(plan.map(r => r.detail).join(' '), /TEMP B-TREE/);
});

test('history logs aggregate D1 row counts without exposing device IDs', async t => {
  const DB = database(t); DB.insert('secret-device', now - slot);
  const wrapped = { prepare(sql) {
    const statement = DB.prepare(sql);
    const wrap = bound => ({ async all() { return { ...await bound.all(), meta: { rows_read: 7 } }; } });
    return { ...wrap(statement), bind: (...args) => wrap(statement.bind(...args)) };
  } };
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(JSON.parse(message)));
  for (const range of ['24h', '7d']) {
    await readHistory(wrapped, now, range);
    assert.deepEqual(logs.at(-1), { event: 'history_read_usage', range, queries: 5, rowsRead: 35, deviceRowsRead: 14, metadataAvailable: true });
  }
  assert.ok(!JSON.stringify(logs).includes('secret-device'));
});

test('failed D1 attempts are counted and reported with incomplete usage metadata', async t => {
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(JSON.parse(message)));
  const DB = { prepare() { return { async all() { throw new Error('D1 unavailable'); } }; } };
  await assert.rejects(readHistory(DB, now), /D1 unavailable/);
  assert.deepEqual(logs, [{ event: 'history_read_usage', range: '24h', queries: 1, rowsRead: 0, deviceRowsRead: 0, metadataAvailable: false }]);
});

test('failure logs include other rooms queries that finish after the first rejection', async t => {
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(JSON.parse(message)));
  let discovery = 0;
  const DB = { prepare(sql) {
    const bound = args => ({ async all() {
      if (sql.startsWith('SELECT device_id')) {
        const results = discovery < 2 ? [{ device_id: String(discovery++) }] : [];
        return { results, meta: { rows_read: 1 } };
      }
      if (args[0] === '0') throw new Error('room failed');
      await new Promise(resolve => setImmediate(resolve));
      return { results: sql.startsWith('SELECT device_name') ? [{ device_name: 'Room', collected_at: now }] : [], meta: { rows_read: 2 } };
    } });
    return { ...bound([]), bind: (...args) => bound(args) };
  } };
  await assert.rejects(readHistory(DB, now), /room failed/);
  assert.deepEqual(logs, [{ event: 'history_read_usage', range: '24h', queries: 7, rowsRead: 9, deviceRowsRead: 3, metadataAvailable: false }]);
});
