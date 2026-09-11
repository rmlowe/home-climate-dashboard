const roomsEl = document.querySelector("#rooms");
const updatedEl = document.querySelector("#updated");
const errorEl = document.querySelector("#error");

async function refresh() {
  try {
    const response = await fetch("/api/readings", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    renderRooms(data.rooms ?? []);

    const updated = new Date(data.updated);
    updatedEl.textContent = `Updated ${updated.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;

    errorEl.hidden = true;
  } catch (error) {
    console.error(error);
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
      card.append(shortcut);
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

