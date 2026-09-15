import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chart, decimate, segments } from '../public/chart.js';

// Minimal DOM adapter for testing node counts and lazy table interactions without a browser.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(type, callback) { this.events[type] = callback; }
  createTHead() { const n = new Node('thead'); this.append(n); return n; }
  createTBody() { const n = new Node('tbody'); this.append(n); return n; }
  insertRow() { const n = new Node('tr'); this.append(n); return n; }
  insertCell() { const n = new Node('td'); this.append(n); return n; }
  contains(node) { return this === node || this.children.some(c => c.contains(node)); }
  focus() { document.activeElement = this; }
  all(tag) { return [...(this.tag === tag ? [this] : []), ...this.children.flatMap(c => c.all(tag))]; }
  querySelector(selector) {
    const value = selector.match(/data-history-focus="([^"]+)"/)?.[1];
    if (value && this.dataset.historyFocus === value) return this;
    return this.children.map(c => c.querySelector(selector)).find(Boolean) ?? null;
  }
}
const intervalMs = 300_000, to = Date.UTC(2026, 8, 15), from = to - 7 * 86_400_000;
const points = Array.from({ length: 2017 }, (_, i) => ({ scheduledAt: from + i * intervalMs,
  collectedAt: from + i * intervalMs, temperature: 20 + Math.sin(i), humidity: 45, online: true }));

test('decimation reduces dense data while preserving endpoints, extrema and separate gaps', () => {
  const run = points.map(p => ({ ...p, temperature: 20 }));
  run[25].temperature = 35; run[26].temperature = 0;
  const reduced = decimate(run, 'temperature', from, to, 300);
  assert.ok(reduced.length <= 304);
  for (const p of [run[0], run[25], run[26], run.at(-1)]) assert.ok(reduced.includes(p));
  assert.deepEqual(reduced, [...reduced].sort((a, b) => a.collectedAt - b.collectedAt));
  run[100].online = false;
  const runs = segments(run, 'temperature', intervalMs).map(r => decimate(r, 'temperature', from, to, 300));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].at(-1), run[99]); assert.equal(runs[1][0], run[101]);
});

test('week charts use bounded paths and lazily paginate exact readings, restoring page and focus', t => {
  const previous = globalThis.document;
  globalThis.document = { activeElement: null, createElement: tag => new Node(tag),
    createElementNS: (_, tag) => new Node(tag), querySelector: () => ({ clientWidth: 360 }) };
  t.after(() => { globalThis.document = previous; });
  const room = { name: 'Office', points };
  const data = { from, to, intervalMs };
  const figure = chart(room, 'temperature', data);
  assert.equal(figure.all('tr').length, 0);
  assert.equal(figure.all('circle').length, 0);
  assert.equal(figure.all('path').length, 1);
  const details = figure.all('details')[0];
  details.open = true; details.events.toggle();
  assert.equal(figure.all('tbody')[0].children.length, 100);
  assert.equal(figure.all('tbody')[0].children[0].children[2].textContent, points[0].temperature.toFixed(1));
  let next = details.querySelector('[data-history-focus="next"]');
  next.focus(); next.events.click();
  assert.equal(details.dataset.page, '1');
  assert.equal(document.activeElement.dataset.historyFocus, 'next');
  assert.equal(figure.all('tbody')[0].children[0].children[2].textContent, points[100].temperature.toFixed(1));
  const refreshed = chart(room, 'temperature', data, undefined, { open: true, page: 1 });
  assert.equal(refreshed.all('details')[0].dataset.page, '1');
  assert.equal(refreshed.all('tbody')[0].children.length, 100);
  const last = chart(room, 'temperature', data, undefined, { open: true, page: 999 });
  assert.equal(last.all('details')[0].dataset.page, '20');
  assert.equal(last.all('tbody')[0].children.length, 17);
  assert.equal(last.querySelector('[data-history-focus="next"]').getAttribute('aria-disabled'), 'true');
});

test('isolated readings remain visible without allocating a DOM node per gap', t => {
  const previous = globalThis.document;
  globalThis.document = { activeElement: null, createElement: tag => new Node(tag),
    createElementNS: (_, tag) => new Node(tag), querySelector: () => ({ clientWidth: 360 }) };
  t.after(() => { globalThis.document = previous; });
  const sparse = points.map((p, i) => ({ ...p, online: i % 2 === 0 }));
  const figure = chart({ name: 'Office', points: sparse }, 'temperature', { from, to, intervalMs });
  assert.equal(figure.all('path').length, 1);
  assert.equal((figure.all('path')[0].attrs.d.match(/M /g) || []).length, 1009);
  assert.equal(figure.all('tr').length, 0);
});
