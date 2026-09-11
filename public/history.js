import { chart, freshness } from './chart.js';

const select = document.querySelector('#history-room');
const status = document.querySelector('#history-status');
const times = document.querySelector('#history-freshness');
const charts = document.querySelector('#history-charts');
const error = document.querySelector('#history-error');
let data;
let busy = false;

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
  charts.replaceChildren(chart(room, 'temperature', data), chart(room, 'humidity', data));
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
    if (data.rooms.some(r => r.id === selected)) select.value = selected;
    select.disabled = !data.rooms.length;
    error.hidden = true;
    if (!data.rooms.length) {
      charts.replaceChildren(); times.textContent = '';
      status.textContent = 'No history collected yet.'; status.className = '';
    } else renderCharts();
  } catch (e) {
    console.error(e);
    error.textContent = data ? 'Unable to refresh history. Showing previously loaded data.' : 'Unable to load history. Retrying automatically.';
    error.hidden = false;
    if (!data) status.textContent = '';
    renderStatus();
  } finally { busy = false; }
}
select.addEventListener('change', renderCharts);
refreshHistory();
setInterval(refreshHistory, 60_000);
setInterval(renderStatus, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshHistory(); });
