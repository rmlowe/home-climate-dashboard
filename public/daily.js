// Calendar days follow the browser's local timezone, including DST transitions.
// Coverage counts occupied collection-time buckets, not replayable scheduled slots.
export function dailySummaries(points, { from, to, intervalMs }) {
  const first = new Date(from);
  first.setHours(0, 0, 0, 0);
  const days = [];
  for (let start = first.getTime(); start < to;) {
    const next = new Date(start);
    next.setDate(next.getDate() + 1);
    const end = next.getTime();
    const lower = Math.max(start, from), upper = Math.min(end, to);
    const valid = points.filter(p => p.collectedAt >= lower && p.collectedAt < end &&
      p.collectedAt < upper && p.online === true && Number.isFinite(p.temperature));
    const buckets = new Set(valid.map(p => Math.floor((p.collectedAt - start) / intervalMs)));
    const expected = Math.max(1, Math.ceil((upper - start) / intervalMs) - Math.floor((lower - start) / intervalMs));
    const values = valid.map(p => p.temperature);
    days.push({ start, partial: lower > start || upper < end,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      coverage: Math.min(100, Math.round(buckets.size / expected * 100)),
      buckets: buckets.size, expected });
    start = end;
  }
  return days;
}

export function dailyTable(room, data) {
  const section = document.createElement('section');
  section.className = 'history-chart daily-summary';
  const heading = document.createElement('h3');
  heading.textContent = 'Daily indoor temperature';
  const note = document.createElement('p');
  note.textContent = 'Local calendar days. Coverage is the share of five-minute periods with a valid temperature in the selected window. Partial days cover only the displayed part of that day; gaps can hide the true minimum or maximum.';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const label of ['Day', 'Min / max', 'Coverage']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell);
  }
  const body = table.createTBody();
  for (const day of dailySummaries(room.points, data)) {
    const row = body.insertRow();
    const date = document.createElement('th'); date.scope = 'row';
    date.textContent = new Date(day.start).toLocaleDateString([], { day: 'numeric', month: 'short' }) + (day.partial ? ' (partial)' : '');
    row.append(date);
    row.insertCell().textContent = day.min === null ? 'No readings' : `${day.min.toFixed(1)} / ${day.max.toFixed(1)} °C`;
    row.insertCell().textContent = `${day.coverage}% (${day.buckets}/${day.expected})`;
  }
  section.append(heading, note, table);
  return section;
}
