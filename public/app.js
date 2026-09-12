const roomsEl = document.querySelector("#rooms");
const updatedEl = document.querySelector("#updated");
const errorEl = document.querySelector("#error");

let outside;
let outsideFresh = false;
let indoorsAt = 0;
function renderComparisons() {
  for (const el of roomsEl.querySelectorAll('.outdoor-comparison')) {
    const temperature = Number(el.dataset.temperature);
    const usable = outsideFresh && Date.now() - indoorsAt <= 90_000 && Number.isFinite(temperature) &&
      el.dataset.online === 'true' && Number.isFinite(outside?.current?.temperature);
    el.hidden = !usable;
    if (usable) {
      const delta = temperature - outside.current.temperature;
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
  try {
    const response = await fetch("/api/readings", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    indoorsAt = Date.parse(data.updated);
    renderRooms(data.rooms ?? []);
    renderComparisons();

    const updated = new Date(data.updated);
    updatedEl.textContent = `Updated ${updated.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;

    errorEl.hidden = true;
  } catch (error) {
    console.error(error);
    indoorsAt = 0; renderComparisons();
    errorEl.textContent = "Unable to refresh the Govee readings right now.";
    errorEl.hidden = false;
  }
}

function renderRooms(rooms) {
  const focusedRoom = document.activeElement?.dataset.historyId;
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
      shortcut.textContent = "View 24-hour history";
      shortcut.setAttribute("aria-label", `View ${room.name} history`);
      shortcut.setAttribute("aria-controls", "history-section");
      const comparison = document.createElement('p');
      comparison.className = 'outdoor-comparison'; comparison.hidden = true;
      comparison.dataset.temperature = Number.isFinite(room.temperature) ? String(room.temperature) : 'NaN';
      comparison.dataset.online = String(room.online === true);
      card.append(comparison, shortcut);
      return card;
    })
  );
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

