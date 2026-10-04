// Keep the compact conclusion useful even when supporting details are closed.
export function ventilationLabel(assessment) {
  if (!assessment || assessment.status === 'unavailable') return 'Window guidance unavailable';
  if (assessment.status === 'uncertain') return 'Window benefit uncertain';
  if (assessment.status === 'within_preferences') return 'No cooling or drying needed';
  if (assessment.status === 'no_clear_benefit') return 'No clear window benefit';
  if (assessment.status === 'tradeoff') {
    if (assessment.drying === 'moister') return 'May cool; adds moisture';
    if (assessment.humidity < 40 && assessment.drying === 'drier') return 'May cool; worsens dryness';
    if (assessment.cooling === 'warmer') return 'May dry; also warms';
    return 'May dry; also cools';
  }
  if (assessment.temperature > 25 && assessment.humidity > 60 && assessment.drying === 'drier') return 'Ventilation may cool and dry';
  return assessment.temperature > 25 && assessment.cooling === 'cooler'
    ? 'Ventilation may help cool' : 'Ventilation may help dry';
}

export function renderVentilationCard(element, assessment, now = Date.now()) {
  const expired = assessment?.validUntil !== null && assessment?.validUntil <= now;
  const usable = assessment && !expired;
  element.dataset.status = usable ? assessment.status : 'unavailable';
  // Reuse the summary so periodic updates retain keyboard focus and open state.
  let summary = element.querySelector('summary');
  let body = element.querySelector('.ventilation-body');
  if (!summary) {
    summary = document.createElement('summary');
    summary.dataset.ventilationId = element.dataset.roomId ?? '';
    body = document.createElement('div');
    body.className = 'ventilation-body';
    element.append(summary, body);
  }
  summary.textContent = ventilationLabel(usable ? assessment : null);
  body.replaceChildren();
  const explanation = document.createElement('p');
  explanation.textContent = usable ? assessment.summary : 'Waiting for fresh readings.';
  body.append(explanation);
  if (!usable) return;
  if (assessment.cooling !== 'unknown' && assessment.drying !== 'unknown') {
    const effects = document.createElement('p');
    effects.className = 'ventilation-effects';
    const cooling = { cooler: 'Cooling potential', warmer: 'Warming potential', similar: 'Little temperature difference' };
    const drying = { drier: 'Drying potential', moister: 'Moisture gain', similar: 'Little moisture difference' };
    effects.textContent = `${cooling[assessment.cooling]} · ${drying[assessment.drying]}`;
    body.append(effects);
    const values = document.createElement('p');
    values.className = 'ventilation-values';
    values.textContent = `Dew point: ${assessment.indoorDewPoint.toFixed(1)}°C inside · ${assessment.outdoorDewPoint.toFixed(1)}°C outside estimate`;
    body.append(values);
  }
  if (assessment.reasons.length && assessment.status !== 'unavailable') {
    const reasons = document.createElement('p');
    reasons.textContent = assessment.reasons.join(' ');
    body.append(reasons);
  }
}
