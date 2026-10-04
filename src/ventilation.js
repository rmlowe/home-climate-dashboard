import { dewPoint } from '../public/comparison-summary.js';
import { indoorFresh, weatherFresh, INDOOR_COMPARISON_MAX_AGE_MS } from '../public/weather-model.js';

// Conservative product defaults, not calibrated error bounds or safety limits.
export const ventilationPolicy = Object.freeze({ temperatureMarginC: 2, dewPointMarginC: 2,
  substantialCoolingC: 5, highTemperatureC: 25, humidityMinPercent: 40, humidityMaxPercent: 60,
  lowTemperatureC: null, confirmationWindowMs: 12 * 60_000, confirmationLatestMaxAgeMs: 7 * 60_000,
  confirmationMinSeparationMs: 4 * 60_000 });
export const ventilationScope = 'Temperature and moisture guidance only; not an air-quality, CO2 or safety assessment. '
  + 'Outdoor values are Open-Meteo local estimates, not balcony measurements. '
  + 'Indoor timestamps are API retrieval times, not sensor measurement times. '
  + 'Margins are provisional product defaults, not calibrated uncertainty bounds. '
  + 'No minimum comfortable temperature is configured. No window duration or final room conditions are predicted.';

function validTemperature(t) { return Number.isFinite(t) && t >= -100 && t <= 70; }
function effects(room, current) {
  const temperatureDifference = room.temperature - current.temperature;
  const indoorDewPoint = dewPoint(room.temperature, room.humidity);
  const outdoorDewPoint = dewPoint(current.temperature, current.humidity);
  const dewPointDifference = indoorDewPoint - outdoorDewPoint;
  return { temperatureDifference, indoorDewPoint, outdoorDewPoint, dewPointDifference,
    cooling: temperatureDifference >= ventilationPolicy.temperatureMarginC ? 'cooler'
      : temperatureDifference <= -ventilationPolicy.temperatureMarginC ? 'warmer' : 'similar',
    drying: dewPointDifference >= ventilationPolicy.dewPointMarginC ? 'drier'
      : dewPointDifference <= -ventilationPolicy.dewPointMarginC ? 'moister' : 'similar' };
}
function needs(room) {
  return { hot: room.temperature > ventilationPolicy.highTemperatureC,
    humid: room.humidity > ventilationPolicy.humidityMaxPercent,
    dry: room.humidity < ventilationPolicy.humidityMinPercent };
}
function complete(room) {
  return room?.online === true && validTemperature(room.temperature) && dewPoint(room.temperature, room.humidity) !== null;
}
function signature(room, current) {
  const e = effects(room, current), n = needs(room);
  return JSON.stringify([e.cooling, e.drying, n.hot, n.humid, n.dry,
    e.temperatureDifference >= ventilationPolicy.substantialCoolingC]);
}

export function assessVentilation(room, snapshotAt, weather, historyRoom, now = Date.now()) {
  const roomAt = room.retrievedAt ?? snapshotAt;
  const result = { id: room.id, name: room.name,
    temperature: Number.isFinite(room.temperature) ? room.temperature : null,
    humidity: Number.isFinite(room.humidity) ? room.humidity : null, online: room.online ?? null,
    indoorRetrievedAt: roomAt ?? null, indoorFresh: indoorFresh(snapshotAt, now) && indoorFresh(roomAt, now),
    status: 'unavailable', summary: '',
    cooling: 'unknown', drying: 'unknown', temperatureDifference: null, dewPointDifference: null,
    indoorDewPoint: null, outdoorDewPoint: null, validUntil: null,
    confirmation: { confirmed: false, samples: 0, firstAt: null, lastAt: null }, reasons: [] };
  if (room.online !== true) result.reasons.push('Room sensor is offline or its status is unknown.');
  if (!indoorFresh(snapshotAt, now) || !indoorFresh(roomAt, now)) result.reasons.push('Fresh indoor readings are unavailable.');
  if (!weatherFresh(weather, now)) result.reasons.push('A fresh outdoor estimate is unavailable.');
  if (!complete(room) || !validTemperature(weather?.current?.temperature) ||
      dewPoint(weather?.current?.temperature, weather?.current?.humidity) === null) {
    result.reasons.push('Valid temperature and humidity are required from both sources (humidity must be above 0%).');
  }
  if (result.reasons.length) {
    result.summary = 'Window guidance unavailable. ' + result.reasons.join(' ');
    return result;
  }
  Object.assign(result, effects(room, weather.current));
  result.validUntil = Math.min(Date.parse(snapshotAt) + INDOOR_COMPARISON_MAX_AGE_MS,
    Date.parse(roomAt) + INDOOR_COMPARISON_MAX_AGE_MS, weather.fetchedAt + 45 * 60_000,
    weather.current.validAt + 60 * 60_000);

  // Confirm the current conclusion against the last two distinct stored retrievals.
  // Repeated UI/MCP calls cannot count as independent observations. Invalid samples
  // are retained so an offline/incomplete sample interrupts confirmation.
  const points = [...new Map((historyRoom?.points ?? []).filter(p =>
    Number.isFinite(p.collectedAt) && p.collectedAt >= now - ventilationPolicy.confirmationWindowMs &&
    p.collectedAt < Date.parse(roomAt)).map(p => [p.collectedAt, p])).values()]
    .sort((a, b) => a.collectedAt - b.collectedAt).slice(-2);
  result.confirmation = { confirmed: points.length === 2 &&
    points[1].collectedAt - points[0].collectedAt >= ventilationPolicy.confirmationMinSeparationMs &&
    now - points[1].collectedAt <= ventilationPolicy.confirmationLatestMaxAgeMs &&
    points.every(p => complete(p) && signature(p, weather.current) === signature(room, weather.current)),
  samples: points.length, firstAt: points[0]?.collectedAt ?? null, lastAt: points.at(-1)?.collectedAt ?? null };
  if (!result.confirmation.confirmed) {
    result.status = 'uncertain';
    result.summary = 'Current differences are shown, but recent indoor readings do not yet confirm stable guidance. Recheck after the next collection.';
    result.reasons.push('Confirmation needs two distinct recent indoor collections agreeing with the current assessment against the current outdoor estimate.');
    return result;
  }
  result.validUntil = Math.min(result.validUntil,
    points[0].collectedAt + ventilationPolicy.confirmationWindowMs,
    points[1].collectedAt + ventilationPolicy.confirmationLatestMaxAgeMs);
  const n = needs(room);
  const coolingHelps = n.hot && result.cooling === 'cooler';
  const dryingHelps = n.humid && result.drying === 'drier';
  const moistureCost = result.drying === 'moister' || (n.dry && result.drying === 'drier');
  const coolingCost = dryingHelps && !n.hot && result.cooling === 'cooler';
  if (coolingHelps || dryingHelps) {
    result.status = moistureCost || coolingCost || (dryingHelps && result.cooling === 'warmer') ? 'tradeoff' : 'helpful';
    result.summary = coolingHelps && dryingHelps ? 'Ventilation could help cool and dry this room.'
      : coolingHelps ? 'Ventilation could help cool this room.' : 'Ventilation could help reduce this room’s moisture.';
    if (result.drying === 'moister') result.reasons.push('Incoming air would add moisture.');
    if (n.dry && result.drying === 'drier') result.reasons.push('The room is already below your humidity range; incoming air could worsen dryness.');
    if (coolingCost) result.reasons.push(result.temperatureDifference >= ventilationPolicy.substantialCoolingC
      ? 'Outside is substantially colder; airing also has a cooling cost. No lower comfort temperature is configured.'
      : 'Airing would also cool the room. No lower comfort temperature is configured.');
    if (dryingHelps && result.cooling === 'warmer') result.reasons.push('Incoming air would also warm the room.');
    result.reasons.push('Try a brief airing if comfortable, then reassess; the required duration is unknown.');
  } else if (!n.hot && !n.humid && !n.dry) {
    result.status = 'within_preferences';
    result.summary = 'No cooling or drying action is indicated by your upper temperature and humidity preferences.';
    result.reasons.push('This does not assess whether the room is too cold or needs fresh air for other reasons.');
  } else {
    result.status = 'no_clear_benefit';
    result.summary = 'No clear cooling or drying benefit for the room’s current comfort needs.';
    if (n.dry) result.reasons.push('Humidity is below your preferred range; this feature does not recommend ventilation as a humidifier.');
    if (result.cooling === 'similar' || result.drying === 'similar') result.reasons.push('Small differences fall within the comparison margins.');
  }
  return result;
}
