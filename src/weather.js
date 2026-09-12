const REFRESH_MS = 15 * 60_000;
const DAY = 86_400_000;

export function weatherLocation(env) {
  const latitude = Number(env.WEATHER_LATITUDE);
  const longitude = Number(env.WEATHER_LONGITUDE);
  if (env.WEATHER_LATITUDE == null || env.WEATHER_LONGITUDE == null ||
      String(env.WEATHER_LATITUDE).trim() === '' || String(env.WEATHER_LONGITUDE).trim() === '' ||
      !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error('Weather location is not configured');
  return { latitude, longitude, key: `${latitude},${longitude}` };
}

export function parseWeather(body, fetchedAt) {
  const units = u => u?.time === 'unixtime' && u.temperature_2m === '°C' && u.relative_humidity_2m === '%';
  if (!units(body.current_units) || !units(body.hourly_units)) throw new Error('Unexpected weather units');
  const value = (v, low, high) => typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high ? v : null;
  const point = (time, temperature, humidity) => {
    const validAt = typeof time === 'number' && Number.isFinite(time) ? time * 1000 : NaN;
    if (!Number.isSafeInteger(validAt) || validAt < fetchedAt - 2 * DAY || validAt > fetchedAt) return null;
    return { validAt, temperature: value(temperature, -100, 70), humidity: value(humidity, 0, 100) };
  };
  const current = point(body.current?.time, body.current?.temperature_2m, body.current?.relative_humidity_2m);
  const h = body.hourly;
  if (!current || !Array.isArray(h?.time) || !Array.isArray(h.temperature_2m) ||
      !Array.isArray(h.relative_humidity_2m) || h.time.length !== h.temperature_2m.length ||
      h.time.length !== h.relative_humidity_2m.length) throw new Error('Malformed weather response');
  const points = [...new Map(h.time.map((t, i) => point(t, h.temperature_2m[i], h.relative_humidity_2m[i]))
    .filter(Boolean).map(p => [p.validAt, p])).values()].sort((a, b) => a.validAt - b.validAt);
  return { source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', fetchedAt, current, points };
}

// A persisted 15-minute attempt lease prevents per-viewer requests and retry storms.
// Failures leave the last successful snapshot intact. This is a cache, not a weather archive.
export async function readWeather(env, now = Date.now(), fetcher = fetch) {
  if (!env.DB) throw new Error('Weather storage is not configured');
  const location = weatherLocation(env);
  let row = await env.DB.prepare('SELECT payload FROM weather_cache WHERE location_key = ?').bind(location.key).first();
  const lease = await env.DB.prepare(`INSERT INTO weather_cache (location_key, attempted_at) VALUES (?, ?)
    ON CONFLICT(location_key) DO UPDATE SET attempted_at = excluded.attempted_at
    WHERE weather_cache.attempted_at <= ? RETURNING location_key`).bind(location.key, now, now - REFRESH_MS).first();
  let refreshFailed = false;
  if (lease) {
    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude),
        current: 'temperature_2m,relative_humidity_2m', hourly: 'temperature_2m,relative_humidity_2m',
        past_days: '2', forecast_days: '1', temperature_unit: 'celsius', timezone: 'GMT', timeformat: 'unixtime' });
      const response = await fetcher(url.toString(), { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
      const payload = JSON.stringify(parseWeather(await response.json(), now));
      await env.DB.prepare('UPDATE weather_cache SET payload = ? WHERE location_key = ? AND attempted_at = ?')
        .bind(payload, location.key, now).run();
      row = { payload };
    } catch (error) {
      console.error('Weather refresh failed', error);
      refreshFailed = true;
    }
  }
  if (!row?.payload) throw new Error('Weather data is not available yet');
  const data = JSON.parse(row.payload);
  return { ...data, location: env.WEATHER_LOCATION_NAME || 'Local area', refreshFailed,
    stale: now - data.fetchedAt > 45 * 60_000 || now - data.current.validAt > 60 * 60_000,
    from: now - DAY, to: now, points: data.points.filter(p => p.validAt >= now - DAY && p.validAt <= now) };
}

export async function handleWeather(request, env) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  if ([...new URL(request.url).searchParams].length) return Response.json({ error: 'Weather query parameters are not supported' }, { status: 400, headers });
  try { return Response.json(await readWeather(env), { headers }); }
  catch (error) {
    console.error('Unable to read weather', error);
    return Response.json({ error: 'Outdoor estimate is currently unavailable' }, { status: 503, headers });
  }
}
