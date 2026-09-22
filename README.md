# Home Climate Dashboard

A small private-use web dashboard for displaying current and historical temperature and humidity readings from Govee H5179 thermo-hygrometers.

The app runs on Cloudflare Workers. Static HTML/CSS/JavaScript is served alongside a Worker API endpoint that talks to the official Govee OpenAPI. The Govee API key is stored as a Cloudflare secret and is never sent to the browser or committed to GitHub.

## Architecture

```text
Browser / installed PWA
   |
   +-- GET / --------------------> static dashboard
   |
   +-- GET /api/readings --------> Cloudflare Worker
                                      |
                                      +--> Govee OpenAPI
```

The Worker discovers compatible thermometer devices, fetches their current state in parallel, converts the observed H5179 Fahrenheit readings to Celsius, and returns a small JSON response. The shared current-reading snapshot is cached internally at the Worker for 30 seconds to avoid unnecessary Govee API calls. Dashboard and MCP responses use private/no-store headers; neither exposes the internal cache entry.

## Progressive Web App

The dashboard is installable as a PWA. It includes a web app manifest, install icons, and a minimal service worker. The service worker caches only static assets; navigations and `/api/readings` are always fetched from the network so Cloudflare Access remains in the request path and live sensor data is never served from the browser cache.

## Local development

Prerequisites: Node.js 24+ and npm (tests use Node's built-in SQLite).

```bash
npm install
npm run dev
```

Create a local `.dev.vars` file containing:

```text
GOVEE_API_KEY=your-key-here
```

`.dev.vars` is excluded by `.gitignore`; never commit it.

The H5179 units used for this project currently return `sensorTemperature` in Fahrenheit. `wrangler.jsonc` therefore sets `GOVEE_TEMPERATURE_UNIT` to `fahrenheit`, and the Worker converts the value to Celsius before returning it to the browser.

## Deploy

Authenticate Wrangler with Cloudflare, then ensure the API key exists as an encrypted Worker secret:

```bash
npx wrangler login
npx wrangler secret put GOVEE_API_KEY
npm run deploy
```

`wrangler.jsonc` declares `GOVEE_API_KEY` as a required secret, so future deploys fail clearly if it is missing.

The production Worker is protected with Cloudflare Access for approved household email addresses.

## Security

- `GOVEE_API_KEY` is read only by the Worker.
- Raw Govee device identifiers remain server-side. History exposes a stable SHA-256-derived key to distinguish rooms, including duplicate names.
- `.dev.vars` and other local secret files are ignored by Git.
- Cloudflare Access protects the Worker before requests reach the application.
- The PWA service worker does not cache HTML navigations or `/api/*`.

## History collection

The Worker includes a five-minute scheduled collector, and the provisioned D1 database is bound as `DB`. The five-minute cron is enabled in configuration and starts collecting once this version is deployed. The owner confirmed creation of the production readings table via D1 Console on 8 September 2026; production collection was verified, and freshness was confirmed again on 11 September after recreating a stalled cron trigger on 10 September. The live endpoint does not query D1.

The collector calls Govee directly, independently of browser traffic and the live endpoint's cache. It retains all readings in D1. The history endpoint reads D1 independently of Govee; viewing charts does not trigger additional sensor requests.

- One row per device and five-minute UTC slot. The primary key prevents duplicate writes when a slot is replayed.
- `collected_at` is the actual fetch time; `scheduled_at` identifies the cron slot. Both are Unix milliseconds, not sensor measurement timestamps.
- Device identity combines SKU and Govee device ID, so renaming a room does not split its history. IDs remain server-side.
- Missing or malformed metrics are SQL NULL. Offline or unknown-status sensors retain their status but have NULL metrics.
- Failed sensor requests produce gaps. Other sensors are saved first, then the invocation fails visibly. Discovery and database failures also propagate.
- Each Govee request has a ten-second timeout. There are no application retries; the next scheduled run collects a new slot.
- At three sensors this adds 864 rows/day and approximately 1,152 Govee requests/day (one discovery and three state requests per run), in addition to live-dashboard traffic.

### History API and charts

`GET /api/history` returns a rolling 24-hour window by default. `?range=24h` and `?range=7d` select the supported windows. Unknown parameters, duplicate ranges and unsupported values return 400; other methods return 405. Unconfigured or unavailable storage returns 503. Empty storage returns 200 with an empty `rooms` array. Responses use `Cache-Control: private, no-store` and are excluded from the service worker cache.

The response contains `from`, `to`, `intervalMs`, `staleAfterMs` and `rooms`. All times and durations are milliseconds. Each room has an opaque `id`, its latest `name`, `lastCollectedAt`, `lastValidAt` (nullable), and `points`. Each point includes `scheduledAt`, `collectedAt`, `temperature` (Celsius), `humidity` (percent), and nullable boolean `online`. A valid reading means online with both metrics present. Rooms without samples in the window remain listed, so a stopped collector is not hidden.

Each current-reading card links directly to its room’s history, with keyboard support and reduced-motion-aware scrolling. Live and history responses share an opaque room key, so matching does not depend on room names. Freshness status sits beside the history heading, with detailed timestamps in an expandable Collection details section. The dashboard retains the current-reading cards and adds a room selector with separate temperature and humidity charts. Charts and tables are ordered by actual collection time, with scheduled time breaking ties. The rolling window and latest collection/valid-reading metadata also use collection time. Charts use local time; lines break at missing or replayed scheduled slots, non-increasing collection times, collection gaps over ten minutes, offline readings or a missing metric. Valid zero readings and isolated points are preserved. Expandable tables provide exact values for touch, keyboard and screen-reader users. Rows are built only when opened and paginated in groups of 100; the selected page and control focus survive automatic refreshes. Plotting reduces each uninterrupted run into display-width buckets, retaining endpoints and extrema. Separate SVG subpaths preserve gaps and isolated readings without one DOM node per sample; summaries still use all original readings. Last collection and last valid reading times are shown separately; a ten-minute threshold marks stale data. History refreshes at most every five minutes while the page is visible; changing the selected range fetches immediately, with freshness re-evaluated between requests and old data clearly labelled if refresh fails.

Migration `0002_collection_time_index.sql` adds an index on `(device_id, collected_at, scheduled_at)` for history windows and latest-reading lookups. Apply it with `npx wrangler d1 migrations apply home-climate-history --remote` before rolling out this update. It adds only an index and preserves existing readings. Queries remain correct without the index, but may scan and sort more data. Listing devices uses successive indexed seeks to skip each device’s historical rows, and finding the last valid reading can scan backwards through a device's history; a compact device-summary table may be useful if retention grows substantially. There is currently no retention limit.

### Outdoor weather comparison

The dashboard shows an **Outside · local estimate** summary and green dashed outdoor lines on both 24-hour charts. Room cards show the temperature difference only while indoor and outdoor data are fresh. These are modelled local conditions from [Open-Meteo](https://open-meteo.com/), not balcony measurements. Weather data is attributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free endpoint is intended for non-commercial use; see [API documentation](https://open-meteo.com/en/docs) and [terms](https://open-meteo.com/en/terms).

`WEATHER_LATITUDE`, `WEATHER_LONGITUDE` and `WEATHER_LOCATION_NAME` configure the location in `wrangler.jsonc`. Defaults are approximate Mill Hill East coordinates (51.61, -0.21), not a precise home address. The Worker sends these coordinates to Open-Meteo; no Govee credentials or sensor identifiers are sent. No weather API key is needed.

`GET /api/weather` returns the current estimate and rolling 24-hour hourly series. `validAt` is the weather's applicable time; `fetchedAt` is when the Worker requested the snapshot. Both are UTC Unix milliseconds. Future hourly forecasts are excluded from the comparison. Missing metrics remain null and create chart gaps. Freshness ages independently of page refresh: snapshots older than 45 minutes or current estimates older than one hour are marked delayed. Weather uses its own refresh and error display, so an outage does not hide indoor readings or history.

The existing five-minute cron also checks weather every third slot. Dashboard requests can populate an empty cache or refresh an overdue one, so preview URLs work without their own cron. A D1 attempt lease limits upstream requests to at most one per 15 minutes per location across cron and viewers, including after failures (normally up to 96/day). Failed refreshes retain the previous successful payload. The API is private/no-store and the service worker excludes it.

This stores a bounded snapshot of recent hourly estimates, **not a permanent outdoor archive**. Later model updates may revise the recent series. The first successful request supplies the preceding day immediately; indoor history remains unchanged.

Before previewing or deploying, apply migration `0003_weather_cache.sql` using the normal migration command. On mobile, run this directly in **D1 → home-climate-history → Console**:

```sql
CREATE TABLE IF NOT EXISTS weather_cache (
  location_key TEXT PRIMARY KEY,
  attempted_at INTEGER NOT NULL,
  payload TEXT
);
```

Verify with `PRAGMA table_info('weather_cache');`. This only creates a separate cache table. Running the Wrangler migration later is safe because it also uses `IF NOT EXISTS`. Until the table exists, outdoor data returns 503 and indoor functionality continues normally. Preview and production share the configured database and weather cache.

### Tests

```bash
npm test
```

Run `npm ci` first. Tests need no API key or Cloudflare account. They mock Govee HTTP responses and execute the actual migration, collector and history SQL in an in-memory SQLite database through a small D1 adapter. GitHub Actions runs them on pull requests. They also cover delayed/replayed slots, collection-time window boundaries, latest valid versus incomplete readings, indexed history queries, chart gaps and freshness logic. They do not validate browser rendering, Cloudflare deployment or a live Govee connection.

### Enable collection in production

1. The production database `home-climate-history` has been created and its ID is configured in `wrangler.jsonc`. For a new installation, create a database in the same Cloudflare account as the Worker:

   ```bash
   npx wrangler login
   npx wrangler d1 create home-climate-history --location weur
   ```

2. The production `d1_databases` binding is already enabled. For a new installation, replace its `database_id` with your returned UUID. Keep the binding name `DB`. Do not deploy a placeholder ID.
3. Apply pending migrations before deploying, for both new and existing databases. The production table was created manually using the same schema, so this step can also be run later to register migration `0001_readings.sql` in Wrangler's migration tracking:

   ```bash
   npx wrangler d1 migrations apply home-climate-history --remote
   ```

   The initial migration uses `CREATE TABLE IF NOT EXISTS` to preserve the manually created table and any collected data. This does not validate or repair a different existing schema; it is intended for the identical schema from this repository.

4. The binding and `triggers` (`*/5 * * * *`) are already enabled in this repository. Deploy through the normal production workflow or `npm run deploy`. The existing `GOVEE_API_KEY` secret is reused.
5. After the schedule takes effect, verify rows increase across two five-minute slots:

   ```bash
   npx wrangler d1 execute home-climate-history --remote --command "SELECT device_name, COUNT(*) AS samples, datetime(MAX(collected_at)/1000, 'unixepoch') AS latest_collected_utc FROM readings GROUP BY device_id, device_name;"
   ```

   Inspect scheduled invocation failures and `history_collection` logs using `npx wrangler tail`. The log's `fetched` count includes successful responses even if a duplicate insert is skipped. Confirm `/api/readings` still works behind Cloudflare Access.

To stop collection, set `triggers.crons` to an empty array and deploy. Keep D1 and its binding to preserve saved data. Do not merely omit the triggers section when removing an already-deployed schedule.

### Local collection smoke test

For local-only testing, set `database_id` to a local placeholder such as `local-history`; never commit that value or deploy it. With the existing `.dev.vars` API key:

```bash
npx wrangler d1 migrations apply home-climate-history --local
npx wrangler dev --test-scheduled
```

Use Wrangler's local scheduled-event endpoint to invoke the collector, then inspect the table with `wrangler d1 execute home-climate-history --local`. Local execution uses real Govee requests but a local database; it does not write production history.

References: [D1 setup](https://developers.cloudflare.com/d1/get-started/), [D1 migrations and commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/), [Cron Triggers and local testing](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Current scope

The dashboard shows current readings and selectable 24-hour or seven-day indoor history, with per-chart min/max values and freshness status. Daily indoor temperature summaries use browser-local calendar days, including daylight-saving transitions. Coverage counts distinct five-minute collection-time periods with an online, finite temperature, relative to the portion of each day inside the selected window. Missing days remain visible; partial days are labelled. Min/max values describe available samples, not guaranteed daily extremes. Outdoor overlays retain their recent 24-hour coverage and are labelled accordingly in the seven-day view. No database migration is needed for these longer indoor views. Future additions could include longer outdoor history, overnight cooling summaries, comfort indicators and alerts.

### History read usage

Device discovery seeks the first device ID and then each ID greater than the previous one, using existing indexes. It needs no schema migration and retains stopped devices. History requests emit a `history_read_usage` log with the selected `range`, total `rowsRead`, `deviceRowsRead`, `queries`, and `metadataAvailable`. Counts come from D1 result metadata; if metadata is absent the flag is false and totals are incomplete. Logs contain no device identifiers or readings. Worker logs are enabled in Wrangler. Preview URLs do not support logs, so compare `24h` and `7d` read costs after production deployment; the measured old DISTINCT discovery query read 9,263 rows. Local SQLite query-plan tests verify indexed seeks but cannot establish D1 billed read counts.

Automatic history polling is limited to one attempt per five minutes per page, skips hidden tabs and avoids overlapping requests. Returning to a visible page fetches only when due. Changing the selected range fetches immediately, or after the current request finishes; intermediate range changes are coalesced. Failed attempts for the same range also wait until the next interval, limiting retries. Freshness labels continue to update without database reads. Live readings, weather polling and the scheduled collector are unchanged.


## MCP: current indoor conditions

`POST /mcp` exposes one read-only tool, `get_current_conditions`, through the
Cloudflare stateless MCP handler with Streamable HTTP and SDK legacy-client
compatibility. This is a first integration for MCP Inspector and clients that
accept a configured Authorization header. It does **not** implement OAuth or
provide a ready-to-use consumer assistant sign-in flow yet.

The endpoint is disabled (404) unless `MCP_AUTH_TOKEN` is a secret of at least
32 characters. A valid `Authorization: Bearer <token>` header is required for
all MCP requests, including discovery. Missing/incorrect credentials return 401;
cross-origin browser requests return 403. Tokens are compared via fixed-size
SHA-256 digests using a timing-safe comparison. No CORS access is enabled.
The default SDK Host checks protect local development against DNS rebinding.

The tool takes no arguments and returns:

- Room names and the same opaque IDs used by the dashboard/history API.
- Temperature in Celsius, humidity in percent and `online` as true/false/null.
- Per-room and snapshot `retrievedAt` times (UTC ISO strings), plus the 30-second
  cache lifetime. These are API retrieval times, **not sensor measurement times**.
- Null metrics for offline/unknown devices or missing values; valid zero values
  remain zero. An empty device list returns an empty room array.

The dashboard and MCP share the same internal cache and Govee normalization.
The dashboard retains its existing response shape; offline/unknown metrics are
now null there too. MCP emits both structured content and matching JSON text.
Upstream failures return a generic MCP tool error, expose no upstream error
text or credentials, and are not cached. The first tool reads Govee only; it
performs no D1 queries or writes. Outdoor estimates, historical summaries and
collection health are follow-ups.

### Local verification

1. Run `npm ci` and `npm test`. `npx wrangler deploy --dry-run` checks the Worker
   bundle without deploying. CI runs both tests and the dry-run build.
2. Add `MCP_AUTH_TOKEN` to the ignored `.dev.vars` file alongside `GOVEE_API_KEY`.
   Generate a dedicated random token, for example with
   `openssl rand -hex 32`. Never reuse the Govee key or commit either secret.
3. Run `npm run dev` and start MCP Inspector with
   `npx @modelcontextprotocol/inspector`. Use its proxy mode, select Streamable
   HTTP and enter `http://localhost:8787/mcp` (or the port Wrangler reports).
   Configure the Authorization header with `Bearer ` followed by your token.
   Direct cross-origin browser mode is intentionally not enabled.
4. Connect, list tools and call `get_current_conditions` with `{}`. Compare the
   values with the dashboard within the same cache window. Local use makes real
   Govee reads when the cache is empty, but does not run the scheduled collector.

### Remote activation and Access

Merging this PR does not activate MCP: `MCP_AUTH_TOKEN` is absent from committed
configuration and is not a required deployment secret. Preview URLs also remain
disabled unless that environment has explicitly been given the secret.

Before remote activation, verify the Cloudflare Access policy covers `/mcp` on
all relevant hostnames. Retain the existing household Access policy. A client
using this interim header-based setup must satisfy **both** Access and the
Worker token check; the Worker token does not replace an Access session or
Access service credentials. Use a client with support for the necessary headers
and an authorized Access service-token policy if applicable. Do not disable
Access to make the connection work. Consumer assistant OAuth integration is a
separate follow-up requiring an end-to-end client test.

After that configuration is reviewed, the Worker secret can be installed with
`npx wrangler secret put MCP_AUTH_TOKEN`. That command is an activation step,
not part of the test workflow. Verify an unauthenticated request cannot list
or call tools, then test authenticated discovery and readings. Delete the
secret to disable the endpoint again. No database migration is needed.

Tests cover SDK initialization/discovery/calls, authentication before data
access, invalid arguments, shared caching, opaque identifiers, units, offline
and missing values, and sanitized upstream errors. They do not establish remote
Access policy correctness or consumer-client OAuth compatibility.
