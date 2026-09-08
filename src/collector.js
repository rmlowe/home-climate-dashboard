import { discoverThermometers, readThermometer } from "./govee.js";

const INTERVAL_MS = 5 * 60 * 1000;

export async function collectReadings(env, scheduledTime) {
  if (!env.DB) throw new Error("History DB binding is not configured");
  if (!Number.isFinite(scheduledTime) || scheduledTime < 0) {
    throw new Error("Invalid scheduled time");
  }
  const scheduledAt = Math.floor(scheduledTime / INTERVAL_MS) * INTERVAL_MS;
  const devices = await discoverThermometers(env);
  if (!devices.length) throw new Error("No Govee thermometers discovered");
  const results = await Promise.allSettled(devices.map((device) => readThermometer(env, device)));
  const readings = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (readings.length) {
    await env.DB.batch(readings.map((reading) => env.DB.prepare(`
      INSERT INTO readings
        (device_id, scheduled_at, collected_at, device_name, temperature_c, humidity_percent, online)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (device_id, scheduled_at) DO NOTHING
    `).bind(
      reading.deviceId, scheduledAt, reading.collectedAt, reading.name,
      reading.online === true ? reading.temperature : null,
      reading.online === true ? reading.humidity : null,
      reading.online === null ? null : Number(reading.online),
    )));
  }
  // Save successful sensors first, then mark the invocation failed for observability.
  // Replaying this slot fills missing sensors without overwriting earlier successes.
  const failed = results.length - readings.length;
  console.log(JSON.stringify({ event: "history_collection", scheduledAt, fetched: readings.length, failed }));
  if (failed) throw new Error(`Unable to collect ${failed} of ${devices.length} thermometers`);
}
