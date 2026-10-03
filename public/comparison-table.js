import { compareRoomHistory } from './comparison-summary.js';

export function comparisonTable(room, history) {
  const section = document.createElement('section');
  section.className = 'history-chart period-summary';
  const heading = document.createElement('h3');
  heading.textContent = 'Indoor / outdoor comparison';
  const note = document.createElement('p');
  section.append(heading, note);
  if (!history.outdoor?.available) {
    note.textContent = 'Outdoor history unavailable. Indoor history is still shown below.';
    return section;
  }
  const summary = compareRoomHistory(room, history.outdoor, history);
  note.textContent = 'Available indoor readings are averaged by hour and paired with the local outdoor estimate for that hour. Changes use the first and last paired hours; gaps remain unknown. Positive differences mean warmer air or a higher dew point indoors. This does not establish the cause of a change or whether to ventilate.';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of ['Paired hours', 'Temperature', 'Dew point']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell);
  }
  const body = table.createTBody();
  const value = n => n === null ? '—' : `${n.toFixed(1)} °C`;
  for (const [label, format] of [
    ['Indoor change', m => value(m.indoor.change)],
    ['Outdoor change', m => value(m.outdoor.change)],
    ['Average indoor − outdoor', m => value(m.difference.mean)],
    ['Paired coverage', m => `${m.difference.observedPeriods}/${m.difference.expectedPeriods} hours (${m.difference.coveragePercent.toFixed(1)}%)`],
  ]) {
    const row = body.insertRow();
    const cell = document.createElement('th'); cell.scope = 'row'; cell.textContent = label; row.append(cell);
    row.insertCell().textContent = format(summary.temperature);
    row.insertCell().textContent = format(summary.dewPoint);
  }
  const attribution = document.createElement('p');
  attribution.textContent = `${history.outdoor.attribution}. Outdoor history builds over time; recent hourly estimates can be revised. Dew point is approximated from temperature and relative humidity.`;
  section.append(table, attribution);
  return section;
}
