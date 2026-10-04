import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessVentilation, ventilationPolicy } from '../src/ventilation.js';

const now = Date.UTC(2026, 9, 4, 13);
const stamp = new Date(now).toISOString();
const indoor = { id: 'bedroom', name: 'Bedroom', online: true, temperature: 24, humidity: 65, retrievedAt: stamp };
const outside = { fetchedAt: now, current: { validAt: now, temperature: 12, humidity: 85 } };
function history(room = indoor) {
  return { points: [now - 600_000, now - 300_000].map(collectedAt => ({ ...room, collectedAt })) };
}
function assess(room = indoor, weather = outside, stored = history(room)) {
  return assessVentilation(room, stamp, weather, stored, now);
}

test('higher outdoor RH can dry indoors; strong cooling cost is explained', () => {
  const data = assess();
  assert.equal(data.status, 'tradeoff');
  assert.equal(data.cooling, 'cooler');
  assert.equal(data.drying, 'drier');
  assert.ok(Math.abs(data.indoorDewPoint - 17) < 0.1);
  assert.ok(Math.abs(data.outdoorDewPoint - 9.6) < 0.1);
  assert.ok(data.dewPointDifference > 7);
  assert.equal(data.confirmation.confirmed, true);
  assert.match(data.reasons.join(' '), /substantially colder/);
  assert.equal(data.validUntil, now + 90_000);
});

test('cooling and drying benefits follow preferences and expose conflicting effects', () => {
  const hotHumid = { ...indoor, temperature: 28, humidity: 70 };
  assert.equal(assess(hotHumid).status, 'helpful');
  assert.match(assess(hotHumid).summary, /cool and dry/);
  const hotDry = assess({ ...indoor, temperature: 28, humidity: 30 },
    { ...outside, current: { ...outside.current, temperature: 5, humidity: 40 } });
  assert.equal(hotDry.status, 'tradeoff');
  assert.match(hotDry.reasons.join(' '), /worsen dryness/);
  const moister = assess({ ...indoor, temperature: 28, humidity: 50 },
    { ...outside, current: { ...outside.current, temperature: 24, humidity: 95 } });
  assert.equal(moister.cooling, 'cooler');
  assert.equal(moister.drying, 'moister');
  assert.equal(moister.status, 'tradeoff');
  assert.match(moister.reasons.join(' '), /add moisture/);
  const warmDry = assess(indoor, { ...outside, current: { ...outside.current, temperature: 29, humidity: 20 } });
  assert.equal(warmDry.status, 'tradeoff');
  assert.match(warmDry.reasons.join(' '), /warm the room/);
});

test('comfort boundaries are inclusive and do not invent a minimum temperature', () => {
  for (const humidity of [40, 60]) {
    const data = assess({ ...indoor, temperature: 25, humidity });
    assert.equal(data.status, 'within_preferences');
  }
  const cold = assess({ ...indoor, temperature: 10, humidity: 50 });
  assert.equal(cold.status, 'within_preferences');
  assert.match(cold.reasons.join(' '), /too cold/);
  assert.equal(ventilationPolicy.lowTemperatureC, null);
  const dry = assess({ ...indoor, humidity: 30 });
  assert.equal(dry.status, 'no_clear_benefit');
  assert.match(dry.reasons.join(' '), /humidifier/);
});

test('small differences stay neutral while negative and zero temperatures remain valid', () => {
  const near = assess(indoor, { ...outside, current: { ...outside.current, temperature: 23, humidity: 65 } });
  assert.equal(near.cooling, 'similar');
  assert.equal(near.drying, 'similar');
  assert.equal(near.status, 'no_clear_benefit');
  for (const temperature of [0, -5]) {
    assert.equal(assess(indoor, { ...outside, current: { ...outside.current, temperature } }).drying, 'drier');
  }
  const edge = assess(indoor, { ...outside, current: { ...outside.current, temperature: 22 } });
  assert.equal(edge.cooling, 'cooler');
});

test('unavailable inputs suppress recommendation and derived values', () => {
  for (const patch of [{ online: false }, { online: null }, { temperature: null }, { temperature: NaN },
    { temperature: Infinity }, { temperature: 90 }, { humidity: null }, { humidity: 0 }, { humidity: -1 },
    { humidity: 101 }, { retrievedAt: 'bad' }, { retrievedAt: new Date(now - 90_001).toISOString() },
    { retrievedAt: new Date(now + 1).toISOString() }]) {
    const data = assess({ ...indoor, ...patch });
    assert.equal(data.status, 'unavailable', JSON.stringify(patch));
    assert.equal(data.temperatureDifference, null);
  }
  for (const weather of [null, { ...outside, stale: true }, { ...outside, refreshFailed: true },
    { ...outside, fetchedAt: now + 1 }, { ...outside, fetchedAt: now - 45 * 60_000 - 1 },
    { ...outside, current: { ...outside.current, validAt: now - 60 * 60_000 - 1 } },
    { ...outside, current: { ...outside.current, humidity: 0 } }]) {
    assert.equal(assess(indoor, weather).status, 'unavailable');
  }
  assert.equal(assessVentilation(indoor, new Date(now - 90_001).toISOString(), outside, history(), now).status, 'unavailable');
});

test('confirmation rejects absent, duplicate, stale, future, invalid and changing observations', () => {
  const good = history().points;
  const cases = [null, { points: [] }, { points: [good[0]] }, { points: [good[0], good[0]] },
    { points: [{ ...good[0], collectedAt: now - 300_001 }, good[1]] },
    { points: good.map(p => ({ ...p, collectedAt: p.collectedAt - 600_000 })) },
    { points: good.map(p => ({ ...p, collectedAt: now + 1 })) },
    { points: [good[0], { ...good[1], online: false }] },
    { points: [good[0], { ...good[1], humidity: null }] },
    { points: [good[0], { ...good[1], humidity: 50 }] }];
  for (const stored of cases) {
    const data = assess(indoor, outside, stored);
    assert.equal(data.status, 'uncertain', JSON.stringify(stored));
    assert.equal(data.confirmation.confirmed, false);
    assert.equal(data.drying, 'drier', 'physical comparison remains available');
  }
  assert.equal(assess(indoor, outside, { points: [...good].reverse() }).confirmation.confirmed, true);
});
