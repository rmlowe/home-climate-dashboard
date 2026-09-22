import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;
afterEach(() => { globalThis.fetch = realFetch; globalThis.caches = realCaches; });
const token = 'test-token-with-at-least-32-characters';
const env = { MCP_AUTH_TOKEN: token, GOVEE_API_KEY: 'private-govee-key', GOVEE_TEMPERATURE_UNIT: 'fahrenheit' };
const ctx = { waitUntil(promise) { return promise; } };
function request(method = 'tools/list', params = {}, headers = {}) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
async function rpc(method, params = {}) {
  const response = await worker.fetch(request(method, params), env, ctx);
  assert.equal(response.status, 200, await (response.status !== 200 ? response.clone().text() : Promise.resolve('')));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find(line => line.startsWith('data:')).slice(5) : text);
}
function setup(states = [{ sensorTemperature: 77, sensorHumidity: 45, online: true }]) {
  let requests = 0;
  const entries = new Map();
  globalThis.caches = { default: {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) { entries.set(key.url, response.clone()); },
  } };
  globalThis.fetch = async (url, init) => {
    requests++;
    if (url.endsWith('/user/devices')) return Response.json({ code: 200, data: states.map((_, i) => ({
      device: `secret-device-${i}`, sku: 'H5179', deviceName: `Room ${i}`, type: 'devices.types.thermometer',
    })) });
    const device = JSON.parse(init.body).payload.device;
    const values = states[Number(device.split('-').at(-1))];
    if (values instanceof Error) throw values;
    return Response.json({ code: 200, payload: { capabilities: Object.entries(values).map(([instance, value]) => ({ instance, state: { value } })) } });
  };
  return { requests: () => requests };
}

test('MCP is disabled without a strong token and rejects unauthorized requests before data access', async () => {
  globalThis.fetch = () => { throw new Error('must not fetch'); };
  for (const secret of [undefined, '', 'short']) {
    assert.equal((await worker.fetch(request(), { ...env, MCP_AUTH_TOKEN: secret }, ctx)).status, 404);
  }
  for (const auth of ['', 'Bearer wrong', `Basic ${token}`]) {
    const response = await worker.fetch(request('tools/list', {}, { Authorization: auth }), env, ctx);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('WWW-Authenticate'), /Bearer/);
  }
  assert.equal((await worker.fetch(request('tools/list', {}, { Origin: 'https://evil.example' }), env, ctx)).status, 403);
});

test('SDK handshake and discovery expose only the read-only current conditions tool', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'home-climate');
  const listed = await rpc('tools/list');
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['get_current_conditions']);
  assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);
});

test('tool returns Celsius, units, retrieval times and opaque IDs; dashboard shares its cache', async () => {
  const state = setup();
  const result = (await rpc('tools/call', { name: 'get_current_conditions', arguments: {} })).result;
  assert.notEqual(result.isError, true);
  const data = result.structuredContent;
  assert.equal(data.temperatureUnit, 'celsius');
  assert.equal(data.humidityUnit, 'percent');
  assert.equal(data.cacheMaxAgeSeconds, 30);
  assert.equal(data.rooms[0].temperature, 25);
  assert.equal(data.rooms[0].humidity, 45);
  assert.ok(Number.isFinite(Date.parse(data.rooms[0].retrievedAt)));
  assert.match(data.timestampMeaning, /not sensor measurement/);
  assert.doesNotMatch(JSON.stringify(result), /secret-device|private-govee-key/);
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  const dashboard = await worker.fetch(new Request('http://localhost/api/readings'), env, ctx);
  const body = await dashboard.json();
  assert.equal(body.rooms[0].id, data.rooms[0].id);
  assert.equal(body.updated, data.retrievedAt);
  assert.equal(state.requests(), 2);
  await rpc('tools/call', { name: 'get_current_conditions', arguments: {} });
  assert.equal(state.requests(), 2);
});

test('offline, unknown, missing and valid zero readings stay distinct', async () => {
  setup([
    { sensorTemperature: 77, sensorHumidity: 45, online: false },
    { sensorTemperature: 77, sensorHumidity: 45 },
    { online: true },
    { sensorTemperature: 32, sensorHumidity: 0, online: true },
  ]);
  const data = (await rpc('tools/call', { name: 'get_current_conditions', arguments: {} })).result.structuredContent;
  assert.deepEqual(data.rooms.map(r => [r.online, r.temperature, r.humidity]), [
    [false, null, null], [null, null, null], [true, null, null], [true, 0, 0],
  ]);
});

test('upstream failure returns a sanitized tool error and is not cached', async () => {
  const state = setup([new Error('private-govee-key secret-device-0')]);
  for (let i = 0; i < 2; i++) {
    const result = (await rpc('tools/call', { name: 'get_current_conditions', arguments: {} })).result;
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /private-govee-key|secret-device/);
  }
  assert.equal(state.requests(), 4);
});

test('unknown tools and unexpected arguments do not fetch readings', async () => {
  const state = setup();
  for (const params of [ { name: 'set_temperature', arguments: {} }, { name: 'get_current_conditions', arguments: { room: 'anything' } } ]) {
    const message = await rpc('tools/call', params);
    assert.ok(message.error || message.result?.isError);
  }
  assert.equal(state.requests(), 0);
});
