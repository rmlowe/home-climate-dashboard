import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual HTML entrypoints, so a disconnected module is detected.
test('page startup fetches live weather and renders outdoor panel and room differences', async t => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.value = '24h'; }
    replaceChildren(...nodes) { this.children = nodes; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
    addEventListener() {}
    querySelector(selector) { return selector === 'h2' ? new Element() : this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...((selector.startsWith('.') ? child.className === selector.slice(1) : child.tagName === selector) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
  }
  const elements = new Map();
  const document = { hidden: false, activeElement: null, addEventListener() {},
    createElement: tagName => Object.assign(new Element(), { tagName }), querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    } };
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = document;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.document = previous.document; globalThis.window = previous.window; });
  t.mock.method(globalThis, 'setInterval', () => 0);
  const now = Date.now(), calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url === '/api/ventilation') return Response.json({ rooms: [{ id: 'bedroom', temperature: 22, humidity: 50, online: true, indoorRetrievedAt: new Date(now).toISOString(), status: 'uncertain', summary: 'Waiting for confirmation.', cooling: 'unknown', drying: 'unknown', validUntil: now + 90_000, reasons: [] }] });
    if (url === '/api/readings') return Response.json({ updated: new Date(now).toISOString(),
      rooms: [{ id: 'bedroom', name: 'Bedroom', temperature: 22, humidity: 50, online: true, retrievedAt: new Date(now).toISOString() }] });
    if (url === '/api/weather') return Response.json({ location: 'Local area', fetchedAt: now,
      current: { validAt: now, temperature: 15, humidity: 65 }, points: [], stale: false, refreshFailed: false });
    if (url.startsWith('/api/history')) return Response.json({ rooms: [] });
    throw new Error(`Unexpected URL ${url}`);
  });
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)) {
    await import(new URL(`../public${match[1]}`, import.meta.url));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('/api/weather'), 'HTML entrypoints must start live weather polling');
  assert.equal(document.querySelector('#outdoor-temperature').textContent, '15.0°C');
  assert.equal(document.querySelector('#weather-status').textContent, 'Local weather estimate');
  const comparison = document.querySelector('#rooms').querySelectorAll('.outdoor-comparison')[0];
  assert.ok(calls.includes('/api/ventilation'));
  const guidance = document.querySelector('#rooms').querySelectorAll('.ventilation-guidance')[0];
  assert.equal(guidance.dataset.status, 'uncertain');
  assert.equal(guidance.children[1].children[0].textContent, 'Waiting for confirmation.');
  assert.equal(comparison.hidden, false);
  assert.equal(comparison.textContent, '7.0°C warmer than outside estimate');
});
