import { weatherLocation } from './weather.js';

const HOUR = 3_600_000;

export async function archiveWeather(DB, locationKey, data) {
  // Archive hourly estimates only, never forecasts or the separate current series.
  const points = data.points.filter(p => p.validAt % HOUR === 0 && p.validAt <= data.fetchedAt);
  if (!points.length) return;
  await DB.batch(points.map(p => DB.prepare(`INSERT INTO weather_history
    (location_key, valid_at, fetched_at, temperature_c, humidity_percent) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(location_key, valid_at) DO UPDATE SET fetched_at = excluded.fetched_at,
      temperature_c = excluded.temperature_c, humidity_percent = excluded.humidity_percent
    WHERE excluded.fetched_at > weather_history.fetched_at`)
    .bind(locationKey, p.validAt, data.fetchedAt, p.temperature, p.humidity)));
}

export async function readOutdoorHistory(env, from, to) {
  if (!env.DB) throw new Error('Weather storage is not configured');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 7 * 86_400_000) {
    throw new Error('History window must be positive and at most seven days');
  }
  const location = weatherLocation(env);
  // Include the start hour for partial-window comparisons. No interpolation.
  const { results } = await env.DB.prepare(`SELECT valid_at, fetched_at, temperature_c, humidity_percent
    FROM weather_history WHERE location_key = ? AND valid_at >= ? AND valid_at < ? ORDER BY valid_at`)
    .bind(location.key, Math.floor(from / HOUR) * HOUR, to).all();
  return { available: true, source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/',
    attribution: 'Weather data by Open-Meteo (CC BY 4.0)', kind: 'modelled_local_estimate',
    location: env.WEATHER_LOCATION_NAME || 'Local area', intervalMs: HOUR,
    points: results.map(r => ({ validAt: r.valid_at, fetchedAt: r.fetched_at,
      temperature: r.temperature_c, humidity: r.humidity_percent })) };
}
