import { summarizeMetric } from './history-summary.js';

const HOUR = 3_600_000;
export const comparisonMeaning = 'Window is [from, to). Online indoor samples inside the window are averaged within UTC hours and paired with the outdoor estimate valid at the start of that same hour (up to 60 minutes apart). Partial edge hours are included. No interpolation or carry-forward across missing hours. Statistics weight paired hours equally, not elapsed time; change is last minus first paired hour. Coverage counts hours with a valid pair, not continuous sensing. Outdoor values are modelled local estimates, not balcony measurements; recent estimates may be revised by later fetches. Dew point uses temperature and relative humidity together; positive indoor-minus-outdoor dew point indicates more moisture indoors, not a ventilation recommendation or proof of causation.';

// Magnus approximation over liquid water. RH=0 has no finite dew point.
export function dewPoint(temperature, humidity) {
  if (!Number.isFinite(temperature) || temperature < -100 || temperature > 70 ||
      !Number.isFinite(humidity) || humidity <= 0 || humidity > 100) return null;
  const gamma = Math.log(humidity / 100) + 17.625 * temperature / (243.04 + temperature);
  return 243.04 * gamma / (17.625 - gamma);
}

function stats(points, metric, window) {
  const { samples, firstCollectedAt, lastCollectedAt, ...rest } = summarizeMetric(points, metric, {
    from: Math.floor(window.from / HOUR) * HOUR, to: window.to, intervalMs: HOUR,
  });
  return { ...rest, hours: samples, firstHour: firstCollectedAt, lastHour: lastCollectedAt };
}

export function compareRoomHistory(room, outdoor, window) {
  const buckets = new Map();
  for (const p of room.points) {
    if (p.online !== true || p.collectedAt < window.from || p.collectedAt >= window.to) continue;
    const hour = Math.floor(p.collectedAt / HOUR) * HOUR;
    if (!buckets.has(hour)) buckets.set(hour, { temperature: [], dewPoint: [] });
    const bucket = buckets.get(hour);
    if (Number.isFinite(p.temperature)) bucket.temperature.push(p.temperature);
    const dew = dewPoint(p.temperature, p.humidity);
    if (dew !== null) bucket.dewPoint.push(dew);
  }
  const outside = new Map(outdoor.points.filter(p => p.validAt >= Math.floor(window.from / HOUR) * HOUR &&
    p.validAt < window.to).map(p => [p.validAt, p]));
  const metric = name => {
    const value = p => name === 'temperature' ? p.temperature : dewPoint(p.temperature, p.humidity);
    const paired = [];
    for (const [hour, bucket] of buckets) {
      const values = bucket[name], out = outside.get(hour);
      if (!values.length || !out || !Number.isFinite(value(out))) continue;
      const indoor = values.reduce((a, b) => a + b, 0) / values.length;
      paired.push({ collectedAt: hour, online: true, indoor, outdoor: value(out), difference: indoor - value(out) });
    }
    return { availableIndoorHours: [...buckets.values()].filter(b => b[name].length).length,
      availableOutdoorHours: [...outside.values()].filter(p => Number.isFinite(value(p))).length,
      indoor: stats(paired, 'indoor', window), outdoor: stats(paired, 'outdoor', window),
      difference: stats(paired, 'difference', window) };
  };
  return { id: room.id, name: room.name, temperature: metric('temperature'), dewPoint: metric('dewPoint') };
}
