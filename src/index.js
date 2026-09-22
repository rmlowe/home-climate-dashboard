import { handleReadings } from "./readings.js";
import { handleMcp } from "./mcp.js";
import { collectReadings } from "./collector.js";
import { handleHistory } from "./history.js";
import { readWeather, handleWeather } from "./weather.js";

export default {
  async scheduled(controller, env) {
    const jobs = [collectReadings(env, controller.scheduledTime)];
    if (env.WEATHER_LATITUDE != null && env.WEATHER_LONGITUDE != null &&
        Math.floor(controller.scheduledTime / 300_000) % 3 === 0) jobs.push(readWeather(env));
    const results = await Promise.allSettled(jobs);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") return handleMcp(request, env, ctx);

    if (url.pathname === "/api/weather") return handleWeather(request, env);

    if (url.pathname === "/api/history") return handleHistory(request, env);

    if (url.pathname === "/api/readings") {
      return handleReadings(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};
