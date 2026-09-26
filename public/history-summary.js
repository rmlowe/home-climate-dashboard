// Shared by the Worker and dashboard. Statistics describe observed samples only.
// Summary windows are [from, to); coverage counts occupied UTC collection periods,
// not elapsed time, scheduled cron slots, or an assumption of continuous sensing.
export function summarizeMetric(points, metric, { from, to, intervalMs }) {
  const valid = points.filter(p => p.collectedAt >= from && p.collectedAt < to &&
    p.online === true && Number.isFinite(p[metric]))
    .sort((a, b) => a.collectedAt - b.collectedAt || a.scheduledAt - b.scheduledAt);
  const firstPeriod = Math.floor(from / intervalMs);
  const expectedPeriods = Math.ceil(to / intervalMs) - firstPeriod;
  const periods = new Set(valid.map(p => Math.floor(p.collectedAt / intervalMs)));
  let run = 0, longestMissingRun = 0;
  for (let i = firstPeriod; i < firstPeriod + expectedPeriods; i++) {
    run = periods.has(i) ? 0 : run + 1;
    longestMissingRun = Math.max(longestMissingRun, run);
  }
  const values = valid.map(p => p[metric]);
  const first = valid[0], last = valid.at(-1);
  return {
    samples: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    first: first?.[metric] ?? null, last: last?.[metric] ?? null,
    change: values.length > 1 && last.collectedAt > first.collectedAt ? last[metric] - first[metric] : null,
    firstCollectedAt: first?.collectedAt ?? null, lastCollectedAt: last?.collectedAt ?? null,
    observedPeriods: periods.size, expectedPeriods,
    coveragePercent: expectedPeriods ? periods.size / expectedPeriods * 100 : 0,
    longestMissingRun,
  };
}

export function summarizeRoom(room, window) {
  return {
    id: room.id, name: room.name,
    temperature: summarizeMetric(room.points, 'temperature', window),
    humidity: summarizeMetric(room.points, 'humidity', window),
  };
}
