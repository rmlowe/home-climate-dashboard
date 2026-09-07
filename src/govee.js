const GOVEE_BASE = "https://openapi.api.govee.com/router/api/v1";

export async function discoverThermometers(env) {
  const response = await goveeFetch(env, "/user/devices");
  if (!Array.isArray(response.data)) throw new Error("Invalid Govee device list");
  return response.data.filter((device) => device.type === "devices.types.thermometer");
}

export async function readThermometer(env, device) {
  if (!device.device || !device.sku) throw new Error("Missing Govee device identity");
  const response = await goveeFetch(env, "/device/state", {
    method: "POST",
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      payload: { sku: device.sku, device: device.device },
    }),
  });
  if (!Array.isArray(response.payload?.capabilities)) {
    throw new Error("Invalid Govee device state");
  }
  const values = Object.fromEntries(response.payload.capabilities.map(
    (capability) => [capability.instance, capability.state?.value]
  ));
  const raw = finiteNumber(values.sensorTemperature);
  const unit = (env.GOVEE_TEMPERATURE_UNIT ?? "fahrenheit").toLowerCase();
  if (unit !== "celsius" && unit !== "fahrenheit") {
    throw new Error("Unsupported GOVEE_TEMPERATURE_UNIT");
  }
  const humidity = finiteNumber(values.sensorHumidity);
  const online = values.online === true || values.online === 1 ? true
    : values.online === false || values.online === 0 ? false : null;
  return {
    deviceId: JSON.stringify([device.sku, device.device]),
    name: device.deviceName ?? device.sku,
    temperature: raw === null ? null : unit === "celsius" ? raw : ((raw - 32) * 5) / 9,
    humidity: humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
    online,
    collectedAt: Date.now(),
  };
}

function finiteNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function goveeFetch(env, path, init = {}) {
  if (!env.GOVEE_API_KEY) throw new Error("GOVEE_API_KEY is not configured");
  const response = await fetch(`${GOVEE_BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", "Govee-API-Key": env.GOVEE_API_KEY },
  });
  if (!response.ok) throw new Error(`Govee HTTP error (${response.status})`);
  const payload = await response.json();
  if (payload.code !== 200) throw new Error("Govee API returned an error");
  return payload;
}
