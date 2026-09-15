import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailySummaries } from '../public/daily.js';
const intervalMs = 300_000;
const at = s => new Date(s).getTime();
const point = (time, temperature = 20, online = true) => ({ collectedAt: at(time), temperature, online });

test('daily ranges retain zero, ignore invalid readings, deduplicate coverage and show empty days', () => {
  const previous = process.env.TZ; process.env.TZ = 'Europe/London';
  try {
    const days = dailySummaries([
      point('2026-09-12T23:00:00Z', 0), point('2026-09-12T23:01:00Z', 22),
      point('2026-09-12T23:05:00Z', null), point('2026-09-12T23:10:00Z', 99, false),
      point('2026-09-14T00:00:00Z', 18),
    ], { from: at('2026-09-12T22:00:00Z'), to: at('2026-09-15T01:00:00Z'), intervalMs });
    assert.equal(days.length, 4);
    assert.equal(days[0].min, null);
    assert.equal(days[0].partial, true);
    assert.equal(days[1].min, 0); assert.equal(days[1].max, 22);
    assert.equal(days[1].buckets, 1); assert.equal(days[1].expected, 288);
    assert.equal(days[1].partial, false);
    assert.equal(days[3].min, null); assert.equal(days[3].coverage, 0);
    assert.equal(days[3].expected, 24); assert.equal(days[3].partial, true);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('local days use 23 and 25 hours across UK daylight-saving transitions', () => {
  const previous = process.env.TZ; process.env.TZ = 'Europe/London';
  try {
    for (const [from, to, count] of [
      ['2026-03-29T00:00:00Z', '2026-03-29T23:00:00Z', 276],
      ['2026-10-24T23:00:00Z', '2026-10-26T00:00:00Z', 300],
    ]) {
      const days = dailySummaries([], { from: at(from), to: at(to), intervalMs });
      assert.equal(days.length, 1); assert.equal(days[0].expected, count);
      assert.equal(days[0].partial, false);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
