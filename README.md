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

The Worker discovers compatible thermometer devices, fetches their current state in parallel, converts the observed H5179 Fahrenheit readings to Celsius, and returns a small JSON response. The complete response is cached at the Worker for 30 seconds to avoid unnecessary Govee API calls.

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

`GET /api/history` returns a fixed rolling 24-hour window. No query parameters are accepted (400); other methods return 405. Unconfigured or unavailable storage returns 503. Empty storage returns 200 with an empty `rooms` array. Responses use `Cache-Control: private, no-store` and are excluded from the service worker cache.

The response contains `from`, `to`, `intervalMs`, `staleAfterMs` and `rooms`. All times and durations are milliseconds. Each room has an opaque `id`, its latest `name`, `lastCollectedAt`, `lastValidAt` (nullable), and `points`. Each point includes `scheduledAt`, `collectedAt`, `temperature` (Celsius), `humidity` (percent), and nullable boolean `online`. A valid reading means online with both metrics present. Rooms without samples in the window remain listed, so a stopped collector is not hidden.

The dashboard retains the current-reading cards and adds a room selector with separate temperature and humidity charts. Charts use local time and actual collection timestamps; lines break at missing scheduled slots, offline readings or a missing metric. Valid zero readings and isolated points are preserved. Expandable tables provide exact values for touch, keyboard and screen-reader users. Last collection and last valid reading times are shown separately; a ten-minute threshold marks stale data. History refreshes every minute, with freshness re-evaluated between requests and old data clearly labelled if refresh fails.

Device/time queries use the existing primary key. No new migration or provisioning is required for this feature. Listing devices scans the existing index, and finding the last valid reading can scan backwards through a device's history; a compact device-summary table may be useful if retention grows substantially. There is currently no retention limit.

### Tests

```bash
npm test
```

Tests need no API key, Cloudflare account or installed dependencies. They mock Govee HTTP responses and execute the actual migration, collector and history SQL in an in-memory SQLite database through a small D1 adapter. GitHub Actions runs them on pull requests. They also cover chart gaps and freshness logic. They do not validate browser rendering, Cloudflare deployment or a live Govee connection.

### Enable collection in production

1. The production database `home-climate-history` has been created and its ID is configured in `wrangler.jsonc`. For a new installation, create a database in the same Cloudflare account as the Worker:

   ```bash
   npx wrangler login
   npx wrangler d1 create home-climate-history --location weur
   ```

2. The production `d1_databases` binding is already enabled. For a new installation, replace its `database_id` with your returned UUID. Keep the binding name `DB`. Do not deploy a placeholder ID.
3. For a new database, apply the migration before deploying the collector. The production table was created manually using the same schema, so this step can also be run later to register migration `0001_readings.sql` in Wrangler's migration tracking:

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

The dashboard shows current readings and the last 24 hours of collected history, with per-chart min/max values and freshness status. Future additions could include longer time ranges, outside conditions, comfort indicators and alerts.
