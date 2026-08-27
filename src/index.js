const GOVEE_BASE = "https://openapi.api.govee.com/router/api/v1";
const CACHE_TTL_SECONDS = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/readings") {
      return handleReadings(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleReadings(request, env, ctx) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, {
      Allow: "GET",
    });
  }

  if (!env.GOVEE_API_KEY) {
    return json({ error: "GOVEE_API_KEY is not configured" }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/readings", request.url), {
    method: "GET",
  });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const devicesResponse = await goveeFetch(env, "/user/devices");
    const devices = (devicesResponse.data ?? []).filter(
      (device) => device.type === "devices.types.thermometer"
    );

    const rooms = await Promise.all(
      devices.map(async (device) => {
        const stateResponse = await goveeFetch(env, "/device/state", {
          method: "POST",
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            payload: {
              sku: device.sku,
              device: device.device,
            },
          }),
        });

        const capabilities = Object.fromEntries(
          (stateResponse.payload?.capabilities ?? []).map((capability) => [
            capability.instance,
            capability.state?.value,
          ])
        );

        const rawTemperature = Number(capabilities.sensorTemperature);
        const humidity = Number(capabilities.sensorHumidity);

        return {
          name: device.deviceName,
          temperature: convertToCelsius(
            rawTemperature,
            env.GOVEE_TEMPERATURE_UNIT ?? "fahrenheit"
          ),
          humidity,
          online: Boolean(capabilities.online),
        };
      })
    );

    const response = json({
      updated: new Date().toISOString(),
      rooms,
    });

    const cacheable = new Response(response.body, response);
    cacheable.headers.set(
      "Cache-Control",
      `public, max-age=${CACHE_TTL_SECONDS}`
    );

    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return cacheable;
  } catch (error) {
    console.error(error);
    return json(
      {
        error: "Unable to retrieve Govee readings",
      },
      502
    );
  }
}

async function goveeFetch(env, path, init = {}) {
  const response = await fetch(`${GOVEE_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Govee-API-Key": env.GOVEE_API_KEY,
      ...(init.headers ?? {}),
    },
  });

  const payload = await response.json();

  if (!response.ok || payload.code !== 200) {
    throw new Error(
      `Govee request failed (${response.status}): ${payload.message ?? payload.msg ?? "unknown error"}`
    );
  }

  return payload;
}

function convertToCelsius(value, unit) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (unit.toLowerCase() === "celsius") {
    return value;
  }

  return ((value - 32) * 5) / 9;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
