export function weatherFresh(weather, now = Date.now()) {
  return !!weather?.current && !weather.stale && !weather.refreshFailed &&
    now >= weather.current.validAt && now - weather.current.validAt <= 60 * 60_000 &&
    now >= weather.fetchedAt && now - weather.fetchedAt <= 45 * 60_000;
}

export function outdoorSegments(points, metric, from, to) {
  const runs = [];
  let run = [];
  let previous;
  for (const point of points.filter(p => p.validAt >= from && p.validAt <= to).sort((a, b) => a.validAt - b.validAt)) {
    if (!Number.isFinite(point[metric]) || (previous && point.validAt - previous.validAt !== 3_600_000)) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (Number.isFinite(point[metric])) run.push({ ...point, collectedAt: point.validAt });
    previous = point;
  }
  if (run.length) runs.push(run);
  return runs;
}
