import { discoverThermometers, readThermometer } from "./govee.js";
import { collectReadings } from "./collector.js";
import { handleHistory } from "./history.js";
const CACHE_TTL_SECONDS = 30;

export default {
  async scheduled(controller, env) {
    await collectReadings(env, controller.scheduledTime);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/history") return handleHistory(request, env);

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
    const devices = await discoverThermometers(env);
    const rooms = await Promise.all(
      devices.map(async (device) => {
        const { name, temperature, humidity, online } = await readThermometer(env, device);
        return { name, temperature, humidity, online: online === true };
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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
