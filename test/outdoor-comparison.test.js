import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indoorFresh, temperatureDifference } from '../public/weather-model.js';
import { outdoorComparison } from '../src/outdoor-tool.js';

const now = Date.UTC(2026, 9, 3);
const retrievedAt = new Date(now).toISOString();
const room = { id: 'opaque', name: 'Bedroom', online: true, temperature: 22, humidity: 50, retrievedAt };
const weather = { location: 'Local area', current: { temperature: 15, humidity: 80, validAt: now },
  fetchedAt: now, stale: false, refreshFailed: false };
const snapshot = { retrievedAt, rooms: [room] };

test('comparison has explicit direction, provenance, timestamp meanings and preserves zeros', () => {
  const data = outdoorComparison(snapshot, weather, now);
  assert.equal(data.rooms[0].temperatureDifference, 7);
  assert.equal(data.outdoor.kind, 'modelled_local_estimate');
  assert.equal(data.outdoor.validAt, now);
  assert.equal(data.outdoor.fresh, true);
  assert.equal(data.indoor.available, true);
  assert.match(data.timestampMeaning, /not sensor measurement/);
  const zero = { ...weather, current: { ...weather.current, temperature: 0, humidity: 0 } };
  const result = outdoorComparison({ ...snapshot, rooms: [{ ...room, temperature: 0, humidity: 0 }] }, zero, now);
  assert.equal(result.rooms[0].temperatureDifference, 0);
  assert.equal(result.outdoor.humidity, 0);
  assert.equal(temperatureDifference({ ...room, temperature: -5 }, retrievedAt, zero, now), -5);
});

test('dashboard and MCP suppress differences for offline, missing, stale and failed readings', () => {
  for (const changed of [{ online: false }, { online: null }, { temperature: null }, { temperature: NaN }]) {
    const input = { ...room, ...changed };
    assert.equal(temperatureDifference(input, retrievedAt, weather, now), null);
    assert.equal(outdoorComparison({ ...snapshot, rooms: [input] }, weather, now).rooms[0].temperatureDifference, null);
  }
  for (const changed of [{ stale: true }, { refreshFailed: true }, { fetchedAt: now + 1 },
    { fetchedAt: now - 45 * 60_000 - 1 }, { current: { ...weather.current, validAt: now + 1 } },
    { current: { ...weather.current, validAt: now - 60 * 60_000 - 1 } },
    { current: { ...weather.current, temperature: null } }]) {
    assert.equal(outdoorComparison(snapshot, { ...weather, ...changed }, now).rooms[0].temperatureDifference, null);
  }
  assert.equal(indoorFresh(retrievedAt, now + 90_000), true);
  for (const time of [null, 'bad', new Date(now + 1).toISOString(), new Date(now - 90_001).toISOString()]) {
    assert.equal(indoorFresh(time, now), false);
    assert.equal(outdoorComparison({ ...snapshot, retrievedAt: time }, weather, now).rooms[0].temperatureDifference, null);
  }
});

test('partial sources and empty discovery stay distinct', () => {
  const outsideOnly = outdoorComparison(null, weather, now);
  assert.equal(outsideOnly.indoor.available, false);
  assert.deepEqual(outsideOnly.rooms, []);
  assert.equal(outsideOnly.outdoor.available, true);
  const insideOnly = outdoorComparison(snapshot, null, now);
  assert.equal(insideOnly.outdoor.available, false);
  assert.equal(insideOnly.outdoor.fresh, false);
  assert.equal(insideOnly.outdoor.stale, null);
  assert.equal(insideOnly.rooms[0].temperature, 22);
  assert.equal(insideOnly.rooms[0].temperatureDifference, null);
  assert.equal(outdoorComparison({ ...snapshot, rooms: [] }, weather, now).indoor.available, true);
});
