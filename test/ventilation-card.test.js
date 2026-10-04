import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVentilationCard, ventilationLabel } from '../public/ventilation-card.js';

test('card removes expired effects and inserts source text safely', t => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
    querySelector(selector) { return this.children.find(child => selector.startsWith('.')
      ? child.className === selector.slice(1) : child.tagName === selector) ?? null; }
  }
  const original = globalThis.document;
  globalThis.document = { createElement: tagName => Object.assign(new Element(), { tagName }) };
  t.after(() => { globalThis.document = original; });
  const el = new Element();
  const data = { status: 'tradeoff', summary: '<script>untrusted text</script>',
    cooling: 'cooler', drying: 'drier', indoorDewPoint: 17, outdoorDewPoint: 9.6,
    reasons: ['Cooling cost.'], validUntil: 1000 };
  renderVentilationCard(el, data, 999);
  assert.equal(el.dataset.status, 'tradeoff');
  const summary = el.children[0];
  el.open = true;
  assert.equal(el.children[1].children[0].textContent, data.summary);
  assert.equal(el.children[1].children[0].innerHTML, undefined);
  assert.equal(el.children[1].children[1].textContent, 'Cooling potential · Drying potential');
  renderVentilationCard(el, data, 1000);
  assert.equal(el.dataset.status, 'unavailable');
  assert.equal(el.children.length, 2);
  assert.match(el.children[1].children[0].textContent, /Waiting for fresh/);
  assert.equal(el.children[1].children.length, 1);
  assert.equal(el.children[0], summary, 'summary keeps focus across refreshes');
  assert.equal(el.open, true, 'refresh preserves expanded state');
  renderVentilationCard(el, null, 0);
  assert.equal(el.dataset.status, 'unavailable');
});


test('compact conclusions retain trade-offs and uncertain states', () => {
  assert.equal(ventilationLabel({ status: 'tradeoff', drying: 'moister' }), 'May cool; adds moisture');
  assert.equal(ventilationLabel({ status: 'tradeoff', drying: 'drier', humidity: 30 }), 'May cool; worsens dryness');
  assert.equal(ventilationLabel({ status: 'tradeoff', cooling: 'warmer' }), 'May dry; also warms');
  assert.equal(ventilationLabel({ status: 'tradeoff', cooling: 'cooler' }), 'May dry; also cools');
  assert.equal(ventilationLabel({ status: 'uncertain', cooling: 'cooler' }), 'Window benefit uncertain');
  assert.equal(ventilationLabel({ status: 'unavailable' }), 'Window guidance unavailable');
  assert.equal(ventilationLabel({ status: 'helpful', temperature: 27, humidity: 65, drying: 'drier' }), 'Ventilation may cool and dry');
  assert.equal(ventilationLabel({ status: 'helpful', temperature: 27, humidity: 45, cooling: 'cooler' }), 'Ventilation may help cool');
});
