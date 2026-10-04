import { renderVentilationCard, matchingGuidance } from './ventilation-card.js';
import { temperatureDifference, indoorFresh } from './weather-model.js';

const roomsEl = document.querySelector("#rooms");
const updatedEl = document.querySelector("#updated");
const errorEl = document.querySelector("#error");

let guidance = null;
let displayedRooms = new Map();
let refreshing = false;
function renderGuidance() {
  for (const el of roomsEl.querySelectorAll('.ventilation-guidance')) {
    renderVentilationCard(el, el.dataset.online === 'true' && indoorFresh(indoorsAt)
      ? matchingGuidance(displayedRooms.get(el.dataset.roomId),
        guidance?.rooms.find(room => room.id === el.dataset.roomId)) : null);
  }
}
async function refreshGuidance() {
  try {
    const response = await fetch('/api/ventilation', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.rooms)) throw new Error('Invalid guidance response');
    guidance = next;
  } catch { guidance = null; }
  renderGuidance();
}
setInterval(renderGuidance, 10_000);
let outside;
let outsideFresh = false;
let indoorsAt = null;
function renderComparisons() {
  for (const el of roomsEl.querySelectorAll('.outdoor-comparison')) {
    const temperature = Number(el.dataset.temperature);
    const delta = temperatureDifference({ temperature, online: el.dataset.online === 'true' },
      indoorsAt, outsideFresh ? outside : null);
    el.hidden = delta === null;
    if (delta !== null) {
      el.textContent = Math.abs(delta) < 0.05 ? 'Same as outside estimate' :
        `${Math.abs(delta).toFixed(1)}°C ${delta > 0 ? 'warmer' : 'cooler'} than outside estimate`;
    }
  }
}
window.addEventListener('weather-updated', event => {
  outside = event.detail.weather; outsideFresh = event.detail.fresh; renderComparisons();
});
setInterval(renderComparisons, 30_000);

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/api/readings", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (indoorsAt !== data.updated) guidance = null;
    indoorsAt = data.updated;
    displayedRooms = new Map((data.rooms ?? []).map(room => [room.id, room]));
    renderRooms(data.rooms ?? []);
    renderComparisons();

    const updated = new Date(data.updated);
    updatedEl.textContent = `Updated ${updated.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;

    errorEl.hidden = true;
    await refreshGuidance();
  } catch (error) {
    console.error(error);
    indoorsAt = null; renderComparisons();
    guidance = null; renderGuidance();
    errorEl.textContent = "Unable to refresh the Govee readings right now.";
    errorEl.hidden = false;
  } finally { refreshing = false; }
}

function renderRooms(rooms) {
  const focusedRoom = document.activeElement?.dataset.historyId;
  const focusedGuidance = document.activeElement?.dataset.ventilationId;
  const expandedRooms = new Set([...roomsEl.querySelectorAll('.ventilation-guidance')]
    .filter(el => el.open).map(el => el.dataset.roomId));
  roomsEl.replaceChildren(
    ...rooms.map((room) => {
      const card = document.createElement("article");
      card.className = "card";

      const temperature = Number.isFinite(room.temperature)
        ? `${room.temperature.toFixed(1)}<span class="metric-unit">°C</span>`
        : "—";
      const humidity = Number.isFinite(room.humidity)
        ? `${room.humidity.toFixed(1)}<span class="metric-unit">%</span>`
        : "—";

      card.innerHTML = `
        <div class="card-head">
          <h2></h2>
          <span class="status">${room.online ? "● Online" : "○ Offline"}</span>
        </div>
        <div class="readings">
          <div>
            <div class="metric-value">${temperature}</div>
            <div class="metric-label">Temperature</div>
          </div>
          <div>
            <div class="metric-value">${humidity}</div>
            <div class="metric-label">Humidity</div>
          </div>
        </div>
      `;
      card.querySelector("h2").textContent = room.name;
      const shortcut = document.createElement("button");
      shortcut.type = "button";
      shortcut.className = "history-shortcut";
      // A previously cached live response may lack the new key for up to 30 seconds.
      shortcut.disabled = !room.id;
      shortcut.dataset.historyId = room.id ?? '';
      shortcut.textContent = "View history";
      shortcut.setAttribute("aria-label", `View ${room.name} history`);
      shortcut.setAttribute("aria-controls", "history-section");
      const comparison = document.createElement('p');
      comparison.className = 'outdoor-comparison'; comparison.hidden = true;
      comparison.dataset.temperature = Number.isFinite(room.temperature) ? String(room.temperature) : 'NaN';
      comparison.dataset.online = String(room.online === true);
      const ventilation = document.createElement('details');
      ventilation.open = expandedRooms.has(room.id);
      ventilation.className = 'ventilation-guidance';
      ventilation.dataset.roomId = room.id;
      ventilation.dataset.online = String(room.online === true);
      renderVentilationCard(ventilation, room.online === true && indoorFresh(indoorsAt)
        ? matchingGuidance(room, guidance?.rooms.find(item => item.id === room.id)) : null);
      const meta = document.createElement('div');
      meta.className = 'card-meta';
      meta.append(comparison, shortcut);
      card.append(meta, ventilation);
      return card;
    })
  );
  if (focusedGuidance) {
    [...roomsEl.querySelectorAll('.ventilation-guidance')]
      .find(el => el.dataset.roomId === focusedGuidance)?.querySelector('summary')?.focus({ preventScroll: true });
  }
  if (focusedRoom) {
    [...roomsEl.querySelectorAll(".history-shortcut")]
      .find(button => button.dataset.historyId === focusedRoom)?.focus({ preventScroll: true });
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}

refresh();
setInterval(refresh, 30_000);
