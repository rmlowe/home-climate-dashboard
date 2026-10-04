export function renderVentilationCard(element, assessment, now = Date.now()) {
  element.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = 'Would opening a window help?';
  element.append(heading);
  const expired = assessment?.validUntil !== null && assessment?.validUntil <= now;
  const usable = assessment && !expired;
  element.dataset.status = usable ? assessment.status : 'unavailable';
  const summary = document.createElement('p');
  summary.textContent = usable ? assessment.summary : 'Window guidance unavailable. Waiting for fresh readings.';
  element.append(summary);
  if (!usable) return;
  if (assessment.cooling !== 'unknown' && assessment.drying !== 'unknown') {
    const effects = document.createElement('p');
    effects.className = 'ventilation-effects';
    const cooling = { cooler: 'Cooling potential', warmer: 'Warming potential', similar: 'Little temperature difference' };
    const drying = { drier: 'Drying potential', moister: 'Moisture gain', similar: 'Little moisture difference' };
    effects.textContent = `${cooling[assessment.cooling]} · ${drying[assessment.drying]}`;
    element.append(effects);
    const values = document.createElement('p');
    values.className = 'ventilation-values';
    values.textContent = `Dew point: ${assessment.indoorDewPoint.toFixed(1)}°C inside · ${assessment.outdoorDewPoint.toFixed(1)}°C outside estimate`;
    element.append(values);
  }
  // Unavailable summaries already contain their reasons.
  if (assessment.reasons.length && assessment.status !== 'unavailable') {
    const reasons = document.createElement('p');
    reasons.textContent = assessment.reasons.join(' ');
    element.append(reasons);
  }
}
