import { discoverThermometers, readThermometer } from './govee.js';
import { roomKey } from './history.js';

export const CACHE_TTL_SECONDS = 30;

// Shared by the dashboard and MCP. The cache contains no raw device identifiers.
export async function readCurrentConditions(request, env, ctx) {
  if (!env.GOVEE_API_KEY) throw new Error('Govee is not configured');
  const cache = caches.default;
  const key = new Request(new URL('/__internal/current-conditions-v1', request.url));
  const cached = await cache.match(key);
  if (cached) return cached.json();

  const devices = await discoverThermometers(env);
  const rooms = await Promise.all(devices.map(async (device) => {
    const reading = await readThermometer(env, device);
    return {
      id: await roomKey(reading.deviceId),
      name: reading.name,
      temperature: reading.online === true ? reading.temperature : null,
      humidity: reading.online === true ? reading.humidity : null,
      online: reading.online,
      retrievedAt: new Date(reading.collectedAt).toISOString(),
    };
  }));
  const snapshot = {
    retrievedAt: new Date().toISOString(),
    temperatureUnit: 'celsius',
    humidityUnit: 'percent',
    timestampMeaning: 'Govee API retrieval time, not sensor measurement time',
    rooms,
  };
  ctx.waitUntil(cache.put(key, Response.json(snapshot, {
    headers: { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` },
  })));
  return snapshot;
}

export async function handleReadings(request, env, ctx) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET' } });
  }
  if (!env.GOVEE_API_KEY) {
    return Response.json({ error: 'GOVEE_API_KEY is not configured' }, { status: 500 });
  }
  try {
    const snapshot = await readCurrentConditions(request, env, ctx);
    // Preserve the dashboard's response shape and boolean online field.
    return Response.json({
      updated: snapshot.retrievedAt,
      rooms: snapshot.rooms.map(({ retrievedAt, online, ...room }) => ({ ...room, online: online === true })),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'Unable to retrieve Govee readings' }, { status: 502 });
  }
}
