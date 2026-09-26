import { summarizeRoom } from './history-summary.js';

export function summaryTable(room, window) {
  const summary = summarizeRoom(room, window);
  const section = document.createElement('section');
  section.className = 'history-chart period-summary';
  const heading = document.createElement('h3');
  heading.textContent = 'Selected period summary';
  const note = document.createElement('p');
  note.textContent = 'Statistics use available online readings. Change compares the first and last observed values. Coverage counts five-minute periods with a valid reading; gaps may hide extremes.';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of ['Statistic', 'Temperature', 'Humidity']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell);
  }
  const body = table.createTBody();
  const value = (n, unit) => n === null ? '—' : `${n.toFixed(1)}${unit}`;
  const date = n => n === null ? '—' : new Date(n).toLocaleString();
  for (const [label, format] of [
    ['Min / max', (m, u) => m.min === null ? 'No readings' : `${value(m.min, u)} / ${value(m.max, u)}`],
    ['Average', (m, u) => value(m.mean, u)],
    ['Change', (m, u) => value(m.change, u === '%' ? ' pp' : u)],
    ['Coverage', m => `${m.coveragePercent.toFixed(1)}% (${m.observedPeriods}/${m.expectedPeriods})`],
    ['First reading', m => date(m.firstCollectedAt)],
    ['Last reading', m => date(m.lastCollectedAt)],
  ]) {
    const row = body.insertRow();
    const cell = document.createElement('th'); cell.scope = 'row'; cell.textContent = label; row.append(cell);
    row.insertCell().textContent = format(summary.temperature, ' °C');
    row.insertCell().textContent = format(summary.humidity, '%');
  }
  section.append(heading, note, table);
  return section;
}
