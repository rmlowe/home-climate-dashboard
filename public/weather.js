import { weatherFresh } from './weather-model.js';
export let weather;
let busy = false;
let failed = false;
const status = document.querySelector('#weather-status');
function renderWeather() {
  const current = weather?.current;
  const format = (v, unit) => Number.isFinite(v) ? `${v.toFixed(1)}${unit}` : '—';
  document.querySelector('#outdoor-temperature').textContent = format(current?.temperature, '°C');
  document.querySelector('#outdoor-humidity').textContent = format(current?.humidity, '%');
  document.querySelector('#weather-location').textContent = weather?.location || 'Local area';
  const fresh = !failed && weatherFresh(weather);
  status.textContent = !weather ? (failed ? 'Outdoor estimate unavailable' : 'Loading outdoor estimate…') :
    !fresh ? 'Outdoor update delayed · showing last estimate' : 'Local weather estimate';
  status.className = fresh ? '' : 'history-warning';
  const time = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  document.querySelector('#weather-times').textContent = weather ?
    `Estimate for ${time(current.validAt)} · Retrieved ${time(weather.fetchedAt)}` : '';
  window.dispatchEvent(new CustomEvent('weather-updated', { detail: { weather, fresh } }));
}
async function refreshWeather() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch('/api/weather', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!next.current || !Array.isArray(next.points)) throw new Error('Invalid weather response');
    weather = next;
    failed = false;
  } catch (error) { console.error(error); failed = true; }
  finally { busy = false; renderWeather(); }
}
refreshWeather();
setInterval(refreshWeather, 60_000);
setInterval(renderWeather, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshWeather(); });
