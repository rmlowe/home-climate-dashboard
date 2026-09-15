import { outdoorSegments, weatherFresh } from './weather-model.js';

// Points arrive in collection order. Break on replayed/missing slots and invalid readings.
export function segments(points, metric, intervalMs) {
  const result = [];
  let run = [];
  let previous;
  for (const point of points) {
    const valid = point.online === true && Number.isFinite(point[metric]);
    // Allow fetch-time jitter, but don't connect across a long collection outage.
    if (!valid || (previous && (point.scheduledAt - previous.scheduledAt !== intervalMs ||
        point.collectedAt <= previous.collectedAt ||
        point.collectedAt - previous.collectedAt > 2 * intervalMs))) {
      if (run.length) result.push(run);
      run = [];
    }
    if (valid) run.push(point);
    previous = point;
  }
  if (run.length) result.push(run);
  return result;
}

export function freshness(room, now, staleAfterMs) {
  if (room.lastCollectedAt == null) return 'No collection recorded';
  if (now - room.lastCollectedAt > staleAfterMs) return 'Collection is stale';
  if (room.lastValidAt == null || now - room.lastValidAt > staleAfterMs) return 'Valid readings are stale';
  const latest = room.points.at(-1);
  if (latest && (latest.online !== true || !Number.isFinite(latest.temperature) || !Number.isFinite(latest.humidity))) {
    return 'Latest reading is unavailable or incomplete';
  }
  return 'History is up to date';
}

const NS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function chart(room, metric, data, weather) {
  const period = data.to - data.from > 86_400_000 ? '7 days' : '24 hours';
  const unit = metric === 'temperature' ? '°C' : '%';
  const label = metric === 'temperature' ? 'Temperature' : 'Relative humidity';
  const figure = document.createElement('figure');
  figure.className = `history-chart ${metric}`;
  const caption = document.createElement('figcaption');
  caption.textContent = label;
  figure.append(caption);
  const runs = segments(room.points, metric, data.intervalMs);
  const outsideRuns = outdoorSegments(weather?.points || [], metric, data.from, data.to);
  const series = [
    { name: room.name, runs, className: '' },
    { name: 'Outside estimate', runs: outsideRuns, className: ' outdoor-series' },
  ];
  const points = [...runs.flat(), ...outsideRuns.flat()];
  const legend = document.createElement('p');
  legend.className = 'chart-legend';
  legend.textContent = `${room.name}: solid · Outside estimate: green dashed` +
    (period === '7 days' && outsideRuns.length ? ' · Outdoor coverage: recent 24 hours only' : '') +
    (!outsideRuns.length ? ' · Outdoor history unavailable' : !weatherFresh(weather) ? ' · Outdoor update delayed' : '');
  figure.append(legend);
  if (!points.length) {
    const empty = document.createElement('p');
    empty.textContent = `No valid ${label.toLowerCase()} readings in the last ${period}.`;
    figure.append(empty);
    return figure;
  }
  const values = points.map(p => p[metric]);
  const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, metric === 'temperature' ? 0.5 : 2);
  const low = metric === 'humidity' ? Math.max(0, min - padding) : min - padding;
  const high = metric === 'humidity' ? Math.min(100, max + padding) : max + padding;
  const width = Math.max(280, Math.min(680, document.querySelector('.shell').clientWidth - 24));
  const right = width - 16;
  const x = t => 58 + (t - data.from) / (data.to - data.from) * (right - 58);
  const y = v => 184 - (v - low) / (high - low) * 160;
  const svg = svgNode('svg', { viewBox: `0 0 ${width} 226`, role: 'img',
    'aria-label': `${room.name} and outside estimate: ${label} over the last ${period}. Combined range: ${min.toFixed(1)}${unit} to ${max.toFixed(1)}${unit}. Gaps indicate unavailable readings.` });
  for (let i = 0; i <= 4; i++) {
    const value = low + (high - low) * i / 4;
    svg.append(svgNode('line', { x1: 58, x2: right, y1: y(value), y2: y(value), class: 'grid-line' }));
    svg.append(svgNode('text', { x: 50, y: y(value) + 5, 'text-anchor': 'end' }, value.toFixed(1)));
  }
  const ticks = width < 420 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const time = data.from + (data.to - data.from) * i / ticks;
    svg.append(svgNode('text', { x: x(time), y: 214, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' },
      (period === '7 days' ? new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short' }) : new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))));
  }
  for (const item of series) for (const run of item.runs) {
    svg.append(svgNode('polyline', { points: run.map(p => `${x(p.collectedAt)},${y(p[metric])}`).join(' '), class: 'series-line' + item.className }));
    for (const point of run) {
      const dot = svgNode('circle', { cx: x(point.collectedAt), cy: y(point[metric]), r: run.length === 1 ? 3 : 1.5, class: 'series-point' + item.className });
      dot.append(svgNode('title', {}, `${item.name} · ${new Date(point.collectedAt).toLocaleString()}: ${point[metric].toFixed(1)}${unit}`));
      svg.append(dot);
    }
  }
  const scroll = document.createElement('div');
  scroll.className = 'chart-scroll';
  scroll.append(svg);
  figure.append(scroll);
  // A native table is usable with keyboard, touch and screen readers.
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'View readings and ranges';
  const ranges = document.createElement('p');
  ranges.textContent = series.map(item => {
    const values = item.runs.flat().map(point => point[metric]);
    return values.length ? `${item.name}: Min ${Math.min(...values).toFixed(1)}${unit} / Max ${Math.max(...values).toFixed(1)}${unit}` : `${item.name}: no valid readings`;
  }).join(' · ');
  details.append(summary, ranges);
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const text of ['Source', 'Time (local)', `${label} (${unit})`]) {
    const th = document.createElement('th'); th.scope = 'col'; th.textContent = text; head.append(th);
  }
  const body = table.createTBody();
  const rows = [
    ...room.points.map(p => ({ ...p, source: room.name })),
    ...(weather?.points || []).filter(p => p.validAt >= data.from && p.validAt <= data.to)
      .map(p => ({ ...p, collectedAt: p.validAt, online: true, source: 'Outside estimate' })),
  ].sort((a, b) => a.collectedAt - b.collectedAt);
  for (const point of rows) {
    const row = body.insertRow();
    row.insertCell().textContent = point.source;
    row.insertCell().textContent = new Date(point.collectedAt).toLocaleString();
    row.insertCell().textContent = point.online === true && Number.isFinite(point[metric]) ? point[metric].toFixed(1) : 'Unavailable';
  }
  details.append(table); figure.append(details);
  return figure;
}
