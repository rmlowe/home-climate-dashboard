# Home Climate Dashboard

A small private-use web dashboard for displaying current temperature and humidity readings from Govee H5179 thermo-hygrometers.

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
- No device identifiers are returned to the browser.
- `.dev.vars` and other local secret files are ignored by Git.
- Cloudflare Access protects the Worker before requests reach the application.
- The PWA service worker does not cache HTML navigations or `/api/readings`.

## History collection

The Worker includes a five-minute scheduled collector, but **collection is disabled until D1 is provisioned and the commented configuration is enabled**. Deploying the default configuration continues to serve the live dashboard without a database.

The collector calls Govee directly, independently of browser traffic and the live endpoint's cache. It retains all readings in D1; no history endpoint or charts are included yet.

- One row per device and five-minute UTC slot. The primary key prevents duplicate writes when a slot is replayed.
- `collected_at` is the actual fetch time; `scheduled_at` identifies the cron slot. Both are Unix milliseconds, not sensor measurement timestamps.
- Device identity combines SKU and Govee device ID, so renaming a room does not split its history. IDs remain server-side.
- Missing or malformed metrics are SQL NULL. Offline or unknown-status sensors retain their status but have NULL metrics.
- Failed sensor requests produce gaps. Other sensors are saved first, then the invocation fails visibly. Discovery and database failures also propagate.
- Each Govee request has a ten-second timeout. There are no application retries; the next scheduled run collects a new slot.
- At two sensors this adds 576 rows/day and approximately 864 Govee requests/day (one discovery and two state requests per run), in addition to live-dashboard traffic.

### Tests

```bash
npm test
```

Tests need no API key, Cloudflare account or installed dependencies. They mock Govee HTTP responses and execute the actual migration and collector SQL in an in-memory SQLite database through a small D1 adapter. GitHub Actions runs them on pull requests. They do not validate Cloudflare deployment or a live Govee connection.

### Enable collection in production

1. Create the database in the same Cloudflare account as the Worker:

   ```bash
   npx wrangler login
   npx wrangler d1 create home-climate-history --location weur
   ```

2. Uncomment `d1_databases` in `wrangler.jsonc` and replace `REPLACE_WITH_CREATED_DATABASE_ID` with the returned UUID. Keep the binding name `DB`. Do not deploy a placeholder ID.
3. Apply the migration before deploying the collector:

   ```bash
   npx wrangler d1 migrations apply home-climate-history --remote
   ```

4. Uncomment `triggers` (`*/5 * * * *`). Commit the real binding and schedule to the repo so future deployments preserve them, then deploy through the normal production workflow or `npm run deploy`. The existing `GOVEE_API_KEY` secret is reused.
5. After the schedule takes effect, verify rows increase across two five-minute slots:

   ```bash
   npx wrangler d1 execute home-climate-history --remote --command "SELECT device_name, COUNT(*) AS samples, datetime(MAX(collected_at)/1000, 'unixepoch') AS latest_collected_utc FROM readings GROUP BY device_id, device_name;"
   ```

   Inspect scheduled invocation failures and `history_collection` logs using `npx wrangler tail`. The log's `fetched` count includes successful responses even if a duplicate insert is skipped. Confirm `/api/readings` still works behind Cloudflare Access.

To stop collection, set `triggers.crons` to an empty array and deploy. Keep D1 and its binding to preserve saved data. Do not merely omit the triggers section when removing an already-deployed schedule.

### Local collection smoke test

Uncomment the D1 binding locally and set `database_id` to a local placeholder such as `local-history`; never commit that value or deploy it. With the existing `.dev.vars` API key:

```bash
npx wrangler d1 migrations apply home-climate-history --local
npx wrangler dev --test-scheduled
```

Use Wrangler's local scheduled-event endpoint to invoke the collector, then inspect the table with `wrangler d1 execute home-climate-history --local`. Local execution uses real Govee requests but a local database; it does not write production history.

References: [D1 setup](https://developers.cloudflare.com/d1/get-started/), [D1 migrations and commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/), [Cron Triggers and local testing](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Current scope

The dashboard shows current readings, with optional background D1 collection once configured. Next additions include a history API, historical charts, min/max values, comfort indicators, custom domains, and temperature/humidity alerts.
