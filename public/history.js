import { chart, freshness } from './chart.js';
import { dailyTable } from './daily.js';
import { createHistoryPoller } from './history-polling.js';
import { weather } from './weather.js';

const rangeSelect = document.querySelector('#history-range');
const select = document.querySelector('#history-room');
const status = document.querySelector('#history-status');
const times = document.querySelector('#history-freshness');
const charts = document.querySelector('#history-charts');
const error = document.querySelector('#history-error');
let data;
let requestedRoom;
let renderedRoom;
const details = document.querySelector('#history-details');

function renderStatus() {
  const room = data?.rooms.find(r => r.id === select.value);
  if (!room) return;
  const message = freshness(room, Date.now(), data.staleAfterMs);
  status.textContent = message;
  status.className = message === 'History is up to date' ? '' : 'history-warning';
  const date = t => t == null ? 'never' : new Date(t).toLocaleString();
  times.textContent = `Last collected: ${date(room.lastCollectedAt)} · Last valid reading: ${date(room.lastValidAt)}`;
}
function renderCharts() {
  const room = data?.rooms.find(r => r.id === select.value);
  if (!room) return;
  // Preserve disclosures and keyboard focus through both history and weather refreshes.
  const previous = renderedRoom === room.id ? [...charts.querySelectorAll('details')].map(detail => ({
    open: detail.open, page: Number(detail.dataset.page || 0),
    focused: detail.contains(document.activeElement) ? document.activeElement.dataset.historyFocus : null,
  })) : [];
  charts.replaceChildren(chart(room, 'temperature', data, weather, previous[0]), chart(room, 'humidity', data, weather, previous[1]), dailyTable(room, data));
  [...charts.querySelectorAll('details')].forEach((detail, index) => {
    const focused = previous[index]?.focused;
    if (focused) detail.querySelector(`[data-history-focus="${focused}"]`)?.focus({ preventScroll: true });
  });
  renderedRoom = room.id;
  details.hidden = false;
  renderStatus();
}
async function refreshHistory(range) {
  try {
    const response = await fetch(`/api/history?range=${range}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.rooms)) throw new Error('Invalid history response');
    if (range !== rangeSelect.value) return;
    document.querySelector('#history-heading').textContent = range === '7d' ? 'Last 7 days' : 'Last 24 hours';
    const selected = select.value;
    data = next;
    select.replaceChildren(...data.rooms.map(room => {
      const option = document.createElement('option');
      option.value = room.id; option.textContent = room.name;
      return option;
    }));
    const target = requestedRoom ?? selected;
    if (data.rooms.some(r => r.id === target)) {
      select.value = target;
      requestedRoom = undefined;
    }
    select.disabled = !data.rooms.length;
    error.hidden = true;
    if (!data.rooms.length) {
      charts.replaceChildren(); times.textContent = ''; details.hidden = true;
      status.textContent = 'No history collected yet.'; status.className = '';
    } else renderCharts();
    if (requestedRoom) showMissingRoom();
  } catch (e) {
    if (range !== rangeSelect.value) return;
    console.error(e);
    error.textContent = data ? 'Unable to refresh history. Showing previously loaded data.' : 'Unable to load history. Retrying automatically.';
    error.hidden = false;
    if (!data) status.textContent = '';
    renderStatus();
  }
}
const historyPoller = createHistoryPoller(refreshHistory, () => document.hidden, Date.now, () => rangeSelect.value);

function showMissingRoom() {
  select.value = '';
  charts.replaceChildren(); details.hidden = true;
  status.textContent = data ? 'No history collected for this room yet.' : 'Loading room history…';
  status.className = '';
}
document.querySelector('#rooms').addEventListener('click', event => {
  const shortcut = event.target.closest('[data-history-id]');
  if (!shortcut) return;
  requestedRoom = shortcut.dataset.historyId;
  if (data?.rooms.some(room => room.id === requestedRoom)) {
    select.value = requestedRoom; requestedRoom = undefined;
    renderCharts();
  } else {
    showMissingRoom();
    historyPoller.refresh();
  }
  const heading = document.querySelector('#history-heading');
  heading.focus({ preventScroll: true });
  document.querySelector('#history-section').scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'start',
  });
});
rangeSelect.addEventListener('change', () => {
  requestedRoom = select.value || requestedRoom;
  data = undefined;
  charts.replaceChildren(); details.hidden = true; error.hidden = true;
  document.querySelector('#history-heading').textContent = rangeSelect.value === '7d' ? 'Last 7 days' : 'Last 24 hours';
  status.textContent = 'Loading history…';
  historyPoller.refresh();
});
select.addEventListener('change', () => { requestedRoom = undefined; renderCharts(); });
historyPoller.refresh();
setInterval(() => historyPoller.refresh(), 30_000);
setInterval(renderStatus, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) historyPoller.refresh(); });

window.addEventListener('weather-updated', renderCharts);
