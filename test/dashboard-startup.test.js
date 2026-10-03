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
    querySelector() { return new Element(); }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.className === selector.slice(1) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
  }
  const elements = new Map();
  const document = { hidden: false, activeElement: null, addEventListener() {},
    createElement: () => new Element(), querySelector(selector) {
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
    if (url === '/api/readings') return Response.json({ updated: new Date(now).toISOString(),
      rooms: [{ id: 'bedroom', name: 'Bedroom', temperature: 22, humidity: 50, online: true }] });
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
  assert.equal(comparison.hidden, false);
  assert.equal(comparison.textContent, '7.0°C warmer than outside estimate');
});
