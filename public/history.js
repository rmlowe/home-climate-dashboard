import { createHistoryPoller } from './history-polling.js';
import { chart, freshness } from './chart.js';
import { weather } from './weather.js';

const select = document.querySelector('#history-room');
const status = document.querySelector('#history-status');
const times = document.querySelector('#history-freshness');
const charts = document.querySelector('#history-charts');
const error = document.querySelector('#history-error');
let data;
let busy = false;
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
    open: detail.open, focused: detail.querySelector('summary') === document.activeElement,
  })) : [];
  charts.replaceChildren(chart(room, 'temperature', data, weather), chart(room, 'humidity', data, weather));
  [...charts.querySelectorAll('details')].forEach((detail, index) => {
    detail.open = previous[index]?.open ?? false;
    if (previous[index]?.focused) detail.querySelector('summary').focus({ preventScroll: true });
  });
  renderedRoom = room.id;
  details.hidden = false;
  renderStatus();
}
async function refreshHistory() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/api/history', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.rooms)) throw new Error('Invalid history response');
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
    console.error(e);
    error.textContent = data ? 'Unable to refresh history. Showing previously loaded data.' : 'Unable to load history. Retrying automatically.';
    error.hidden = false;
    if (!data) status.textContent = '';
    renderStatus();
  } finally { busy = false; }
}
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
    poller.refresh();
  }
  const heading = document.querySelector('#history-heading');
  heading.focus({ preventScroll: true });
  document.querySelector('#history-section').scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'start',
  });
});
select.addEventListener('change', () => { requestedRoom = undefined; renderCharts(); });
const poller = createHistoryPoller(refreshHistory, () => document.hidden);
poller.refresh();
setInterval(() => poller.refresh(), 30_000);
setInterval(renderStatus, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poller.refresh(); });

window.addEventListener('weather-updated', renderCharts);
