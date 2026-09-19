const DAY = 86_400_000;
const SLOT = 300_000;

// Fetch time defines the window and chronology; scheduled slots identify cron gaps.
export async function readHistory(DB, now = Date.now()) {
  const from = now - DAY;
  const usage = { event: 'history_read_usage', queries: 0, rowsRead: 0, deviceRowsRead: 0, metadataAvailable: true };
  async function query(statement, discovery = false) {
    const result = await statement.all();
    usage.queries++;
    const count = result.meta?.rows_read;
    if (Number.isFinite(count)) {
      usage.rowsRead += count;
      if (discovery) usage.deviceRowsRead += count;
    } else usage.metadataAvailable = false;
    return result.results;
  }
  const devices = [];
  let cursor;
  try {
    // Seek past each device's entire range instead of scanning historical entries.
    for (;;) {
      const statement = cursor === undefined
        ? DB.prepare('SELECT device_id FROM readings ORDER BY device_id LIMIT 1')
        : DB.prepare('SELECT device_id FROM readings WHERE device_id > ? ORDER BY device_id LIMIT 1').bind(cursor);
      const [device] = await query(statement, true);
      if (!device) break;
      devices.push(device);
      cursor = device.device_id;
    }
    const rooms = await Promise.all(devices.map(async ({ device_id }) => {
      const [latest] = await query(DB.prepare(`SELECT device_name, collected_at FROM readings
        WHERE device_id = ? AND collected_at <= ? ORDER BY collected_at DESC, scheduled_at DESC LIMIT 1`)
        .bind(device_id, now));
      if (!latest) return null;
      const [valid] = await query(DB.prepare(`SELECT collected_at FROM readings WHERE device_id = ?
        AND collected_at <= ? AND online = 1 AND temperature_c IS NOT NULL
        AND humidity_percent IS NOT NULL ORDER BY collected_at DESC, scheduled_at DESC LIMIT 1`)
        .bind(device_id, now));
      const results = await query(DB.prepare(`SELECT scheduled_at, collected_at, temperature_c,
        humidity_percent, online FROM readings WHERE device_id = ? AND collected_at >= ?
        AND collected_at <= ? ORDER BY collected_at, scheduled_at`)
        .bind(device_id, from, now));
      // An opaque stable key supports duplicate names/renaming without exposing Govee IDs.
      return {
        id: await roomKey(device_id),
        name: latest.device_name,
        lastCollectedAt: latest.collected_at,
        lastValidAt: valid?.collected_at ?? null,
        points: results.map(r => ({
          scheduledAt: r.scheduled_at, collectedAt: r.collected_at,
          temperature: r.online === 1 ? r.temperature_c : null,
          humidity: r.online === 1 ? r.humidity_percent : null,
          online: r.online === null ? null : r.online === 1,
        })),
      };
    }));
    return { from, to: now, intervalMs: SLOT, staleAfterMs: 600_000,
      rooms: rooms.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  } finally {
    // Aggregate counts only: no sensor identifiers or readings in logs.
    console.log(JSON.stringify(usage));
  }
}

export async function handleHistory(request, env) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' },
    { status: 405, headers: { ...headers, Allow: 'GET' } });
  if ([...new URL(request.url).searchParams].length) return Response.json(
    { error: 'History supports a fixed 24-hour window; query parameters are not supported' },
    { status: 400, headers });
  if (!env.DB) return Response.json({ error: 'History storage is not configured' }, { status: 503, headers });
  try {
    return Response.json(await readHistory(env.DB), { headers });
  } catch (error) {
    console.error('Unable to read history', error);
    return Response.json({ error: 'Unable to retrieve history' }, { status: 503, headers });
  }
}

export async function roomKey(deviceId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceId));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}
