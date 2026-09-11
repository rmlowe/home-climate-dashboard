import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { collectReadings } from "../src/collector.js";
import { readThermometer } from "../src/govee.js";
import worker from "../src/index.js";

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;
afterEach(() => { globalThis.fetch = realFetch; globalThis.caches = realCaches; });
const devices = ["Living room", "Bedroom"].map((name, index) => ({
  deviceName: name, device: `sensor-${index}`, sku: "H5179", type: "devices.types.thermometer",
}));
const env = { GOVEE_API_KEY: "test-key", GOVEE_TEMPERATURE_UNIT: "fahrenheit" };
const slot = Date.UTC(2026, 8, 7, 8, 0);

function state(values = { sensorTemperature: 77, sensorHumidity: 45, online: true }) {
  return { code: 200, payload: { capabilities: Object.entries(values).map(([instance, value]) => ({
    instance, state: { value },
  })) } };
}

function mockGovee(states = devices.map(() => state()), list = devices) {
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers["Govee-API-Key"], "test-key");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith("/user/devices")) return Response.json({ code: 200, data: list });
    const request = JSON.parse(options.body);
    const i = devices.findIndex((device) => device.device === request.payload.device);
    assert.equal(request.payload.sku, "H5179");
    if (states[i] instanceof Error) throw states[i];
    return Response.json(states[i]);
  };
}

// Exercise the production SQL and migration against SQLite; only the D1 transport is adapted.
function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_readings.sql", import.meta.url), "utf8"));
  t.after(() => sqlite.close());
  return {
    prepare(sql) { return { bind(...args) { return { sql, args }; } }; },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, args }) => sqlite.prepare(sql).run(...args));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    rows() { return sqlite.prepare("SELECT * FROM readings ORDER BY device_id, scheduled_at").all(); },
  };
}

test("scheduled handler stores both sensors with UTC fetch time and Celsius", async (t) => {
  mockGovee();
  const DB = database(t);
  const before = Date.now();
  await worker.scheduled({ scheduledTime: slot }, { ...env, DB });
  const rows = DB.rows();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.scheduled_at, slot);
    assert.ok(row.collected_at >= before && row.collected_at <= Date.now());
    assert.equal(row.temperature_c, 25);
    assert.equal(row.humidity_percent, 45);
    assert.equal(row.online, 1);
  }
});

test("same-slot replay preserves original values; next slot adds history", async (t) => {
  const DB = database(t);
  mockGovee();
  await collectReadings({ ...env, DB }, slot);
  mockGovee(devices.map(() => state({ sensorTemperature: 86, online: true })));
  await collectReadings({ ...env, DB }, slot + 1000);
  assert.equal(DB.rows().length, 2);
  assert.equal(DB.rows()[0].temperature_c, 25);
  await collectReadings({ ...env, DB }, slot + 300_000);
  assert.equal(DB.rows().length, 4);
  assert.equal(DB.rows()[1].temperature_c, 30);
});

test("one failed sensor leaves a gap while the other is stored; replay fills it", async (t) => {
  const DB = database(t);
  mockGovee([state(), new Error("timeout")]);
  await assert.rejects(collectReadings({ ...env, DB }, slot), /1 of 2/);
  assert.equal(DB.rows().length, 1);
  mockGovee();
  await collectReadings({ ...env, DB }, slot);
  assert.equal(DB.rows().length, 2);
});

test("offline or unknown online state never stores stale measurements", async (t) => {
  const DB = database(t);
  mockGovee([state({ online: false, sensorTemperature: 77, sensorHumidity: 45 }),
    state({ sensorTemperature: 77, sensorHumidity: 45 })]);
  await collectReadings({ ...env, DB }, slot);
  assert.deepEqual(DB.rows().map((r) => [r.online, r.temperature_c, r.humidity_percent]),
    [[0, null, null], [null, null, null]]);
});

test("missing, empty and malformed numbers stay null rather than becoming zero", async (t) => {
  const DB = database(t);
  for (const [index, value] of [null, undefined, "", "  ", false, {}, "bad", "Infinity"].entries()) {
    mockGovee(devices.map(() => state({ sensorTemperature: value, sensorHumidity: value, online: true })));
    await collectReadings({ ...env, DB }, slot + index * 300_000);
  }
  assert.ok(DB.rows().every((r) => r.temperature_c === null && r.humidity_percent === null));
});

test("valid zero and numeric strings are retained, Celsius is not converted", async () => {
  mockGovee([state({ sensorTemperature: "0", sensorHumidity: 0, online: true })]);
  const reading = await readThermometer({ ...env, GOVEE_TEMPERATURE_UNIT: "celsius" }, devices[0]);
  assert.equal(reading.temperature, 0);
  assert.equal(reading.humidity, 0);
});

test("out-of-range humidity is missing", async () => {
  mockGovee([state({ sensorTemperature: 77, sensorHumidity: 101, online: true })]);
  assert.equal((await readThermometer(env, devices[0])).humidity, null);
});

test("discovery and malformed-state errors fail without fabricated readings", async (t) => {
  const DB = database(t);
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(collectReadings({ ...env, DB }, slot), /503/);
  mockGovee([], []);
  await assert.rejects(collectReadings({ ...env, DB }, slot), /No Govee/);
  mockGovee([{ code: 200 }, { code: 400 }]);
  await assert.rejects(collectReadings({ ...env, DB }, slot), /2 of 2/);
  assert.equal(DB.rows().length, 0);
});

test("missing configuration and invalid scheduled time fail clearly", async (t) => {
  const DB = database(t);
  await assert.rejects(collectReadings(env, slot), /DB binding/);
  await assert.rejects(collectReadings({ ...env, DB }, NaN), /scheduled time/);
  await assert.rejects(collectReadings({ DB }, slot), /GOVEE_API_KEY/);
});

test("database failure propagates to the scheduled invocation", async () => {
  mockGovee();
  const DB = { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error("D1 unavailable"); } };
  await assert.rejects(worker.scheduled({ scheduledTime: slot }, { ...env, DB }), /D1 unavailable/);
});

test("live endpoint supplies an opaque room key without a DB", async () => {
  mockGovee();
  let cached;
  globalThis.caches = { default: { match: async () => undefined, put: async (_, response) => { cached = response; } } };
  const pending = [];
  const response = await worker.fetch(new Request("https://example.com/api/readings"), env,
    { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=30");
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["rooms", "updated"]);
  assert.match(body.rooms[0].id, /^[a-f0-9]{64}$/);
  assert.deepEqual(body.rooms[0], { id: body.rooms[0].id, name: "Living room", temperature: 25, humidity: 45, online: true });
  assert.ok(cached);
});

test("initial migration adopts the manually created table without losing data", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const migration = readFileSync(new URL("../migrations/0001_readings.sql", import.meta.url), "utf8");
    sqlite.exec(migration.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE"));
    sqlite.exec("INSERT INTO readings VALUES ('sensor', 0, 1, 'Room', 20, 45, 1)");
    sqlite.exec(migration);
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM readings").get().count, 1);
    assert.equal(sqlite.prepare("SELECT temperature_c FROM readings").get().temperature_c, 20);
  } finally { sqlite.close(); }
});
