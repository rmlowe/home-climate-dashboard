import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVentilationCard } from '../public/ventilation-card.js';

test('card removes expired effects and inserts source text safely', t => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
  }
  const original = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  t.after(() => { globalThis.document = original; });
  const el = new Element();
  const data = { status: 'tradeoff', summary: '<script>untrusted text</script>',
    cooling: 'cooler', drying: 'drier', indoorDewPoint: 17, outdoorDewPoint: 9.6,
    reasons: ['Cooling cost.'], validUntil: 1000 };
  renderVentilationCard(el, data, 999);
  assert.equal(el.dataset.status, 'tradeoff');
  assert.equal(el.children[1].textContent, data.summary);
  assert.equal(el.children[1].innerHTML, undefined);
  assert.equal(el.children[2].textContent, 'Cooling potential · Drying potential');
  renderVentilationCard(el, data, 1000);
  assert.equal(el.dataset.status, 'unavailable');
  assert.equal(el.children.length, 2);
  assert.match(el.children[1].textContent, /Waiting for fresh/);
  renderVentilationCard(el, null, 0);
  assert.equal(el.dataset.status, 'unavailable');
});
