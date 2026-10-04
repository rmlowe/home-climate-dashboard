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

The response contains `from`, `to`, `intervalMs`, `staleAfterMs` and `rooms`. All times and durations are milliseconds. Each room has an opaque `id`, its latest `name`, `lastCollectedAt`, `lastValidAt` (nullable), `lastReadingStatus` (online/offline/unknown/incomplete), and `points`. Each point includes `scheduledAt`, `collectedAt`, `temperature` (Celsius), `humidity` (percent), and nullable boolean `online`. A valid reading means online with both metrics present. Rooms without samples in the window remain listed, so a stopped collector is not hidden.

Each current-reading card links directly to its room’s history, with keyboard support and reduced-motion-aware scrolling. Live and history responses share an opaque room key, so matching does not depend on room names. Freshness status sits beside the history heading, with detailed timestamps in an expandable Collection details section. The dashboard retains the current-reading cards and adds a room selector with separate temperature and humidity charts. Charts and tables are ordered by actual collection time, with scheduled time breaking ties. The rolling window and latest collection/valid-reading metadata also use collection time. Charts use local time; lines break at missing or replayed scheduled slots, non-increasing collection times, collection gaps over ten minutes, offline readings or a missing metric. Valid zero readings and isolated points are preserved. Expandable tables provide exact values for touch, keyboard and screen-reader users. Rows are built only when opened and paginated in groups of 100; the selected page and control focus survive automatic refreshes. Plotting reduces each uninterrupted run into display-width buckets, retaining endpoints and extrema. Separate SVG subpaths preserve gaps and isolated readings without one DOM node per sample; summaries still use all original readings. Last collection and last valid reading times are shown separately; a ten-minute threshold marks stale data. History refreshes at most every five minutes while the page is visible; changing the selected range fetches immediately, with freshness re-evaluated between requests and old data clearly labelled if refresh fails.

Migration `0002_collection_time_index.sql` adds an index on `(device_id, collected_at, scheduled_at)` for history windows and latest-reading lookups. Apply it with `npx wrangler d1 migrations apply home-climate-history --remote` before rolling out this update. It adds only an index and preserves existing readings. Queries remain correct without the index, but may scan and sort more data. Listing devices uses successive indexed seeks to skip each device’s historical rows, and finding the last valid reading can scan backwards through a device's history; a compact device-summary table may be useful if retention grows substantially. There is currently no retention limit.

### Outdoor weather comparison

The dashboard shows an **Outside · local estimate** summary and green dashed outdoor lines on the 24-hour and seven-day charts. Room cards show the temperature difference only while indoor and outdoor data are fresh. These are modelled local conditions from [Open-Meteo](https://open-meteo.com/), not balcony measurements. Weather data is attributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free endpoint is intended for non-commercial use; see [API documentation](https://open-meteo.com/en/docs) and [terms](https://open-meteo.com/en/terms).

`WEATHER_LATITUDE`, `WEATHER_LONGITUDE` and `WEATHER_LOCATION_NAME` configure the location in `wrangler.jsonc`. Defaults are approximate Mill Hill East coordinates (51.61, -0.21), not a precise home address. The Worker sends these coordinates to Open-Meteo; no Govee credentials or sensor identifiers are sent. No weather API key is needed.

`GET /api/weather` returns the current estimate and rolling 24-hour hourly series. `validAt` is the weather's applicable time; `fetchedAt` is when the Worker requested the snapshot. Both are UTC Unix milliseconds. Future hourly forecasts are excluded from the comparison. Missing metrics remain null and create chart gaps. Freshness ages independently of page refresh: snapshots older than 45 minutes or current estimates older than one hour are marked delayed. Weather uses its own refresh and error display, so an outage does not hide indoor readings or history.

The existing five-minute cron also checks weather every third slot. Dashboard requests can populate an empty cache or refresh an overdue one, so preview URLs work without their own cron. A D1 attempt lease limits upstream requests to at most one per 15 minutes per location across cron and viewers, including after failures (normally up to 96/day). Failed refreshes retain the previous successful payload. The API is private/no-store and the service worker excludes it.

The live endpoint retains its bounded cache. Successful refreshes also persist hourly estimates in a separate `weather_history` archive. The first refresh seeds up to the preceding 48 hours supplied by the existing request; the seven-day view fills as collection continues. This makes no extra upstream requests. It does not manufacture a full historical week. Later fetches may revise recent hourly estimates; each archived row retains its latest fetch time.

Before previewing or deploying, apply migration `0003_weather_cache.sql` using the normal migration command. On mobile, run this directly in **D1 → home-climate-history → Console**:

```sql
CREATE TABLE IF NOT EXISTS weather_cache (
  location_key TEXT PRIMARY KEY,
  attempted_at INTEGER NOT NULL,
  payload TEXT
);
```

Verify with `PRAGMA table_info('weather_cache');`. This only creates a separate cache table. Running the Wrangler migration later is safe because it also uses `IF NOT EXISTS`. Until the table exists, outdoor data returns 503 and indoor functionality continues normally. Preview and production share the configured database and weather cache.

### Persistent outdoor history and historical comparisons

**Deployment prerequisite:** apply `0004_weather_history.sql` before deploying this version (including previews, which share the production database):

```sh
npx wrangler d1 migrations apply home-climate-history --remote
```

Alternatively, run the following in **D1 → home-climate-history → Console**:

```sql
CREATE TABLE IF NOT EXISTS weather_history (
  location_key TEXT NOT NULL,
  valid_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  temperature_c REAL,
  humidity_percent REAL,
  PRIMARY KEY (location_key, valid_at)
);
```

Verify with `PRAGMA table_info('weather_history');`. The migration is additive and idempotent; it does not change indoor readings or the weather cache. Rolling back the Worker can leave the table in place. Without this table, new weather refreshes fail and retain any previous cached snapshot; indoor collection and history remain available.

The archive stores hourly Open-Meteo model estimates, isolated by configured coordinates. Only hours at or before retrieval time are stored; the separate current-weather series and future forecasts are excluded. Repeated retrievals update a row only when `fetched_at` is newer, so a delayed write cannot replace a newer revision. A model revision may replace a metric with null, which correctly creates a gap. There is no retention deletion; growth is approximately 24 rows/day/location, although recent rows are updated each refresh. A long outage may leave gaps beyond the upstream request's 48-hour lookback. Changing coordinates starts a separate series.

`GET /api/history?range=24h` (or `7d`) adds `outdoor`, with source/attribution, location, hourly `intervalMs`, and `points` containing `validAt`, `fetchedAt`, `temperature` and `humidity`. An empty archive returns `available: true` with no points; unavailable archive/configuration returns `available: false` and no points while retaining indoor history. It is a database-only read. For partial first hours, the returned outdoor series includes the hour-start estimate immediately before `from`; charts clip to the selected window.

The authenticated MCP tool `get_history_comparison({from?, to?})` uses the same archive. Omit both arguments for the last 24 hours, or provide both ISO timestamps with explicit `Z`/UTC offsets for a positive window within the last seven days. For example:

```json
{"from":"2026-10-02T23:00:00+01:00","to":"2026-10-03T08:00:00+01:00"}
```

It returns source provenance, archive valid/fetch time bounds, and per-room `temperature` and `dewPoint` comparisons. Each contains `availableIndoorHours`, `availableOutdoorHours`, and `indoor`, `outdoor`, `difference` statistics over **the same paired hours**. Statistics include min/max/mean, first/last/change, first/last UTC hour, valid/expected hour counts, coverage and longest missing run. Differences are indoor minus outdoor, in Celsius. Null values mean no valid statistic; a single paired hour has no change. Storage failure returns a sanitized tool error, distinct from empty history. Existing MCP tools and authentication are unchanged.

Indoor online samples within `[from, to)` are averaged by UTC hour and paired with the estimate valid at that hour's start. Partial edge hours count in coverage. The estimate and indoor samples can be up to 60 minutes apart: this is hourly alignment, not simultaneous measurement. Missing hours are neither interpolated nor carried forward. Each paired hour has equal statistical weight, irrespective of sample count; hourly coverage does not establish complete within-hour sampling. Use `get_collection_health` for five-minute indoor coverage. `firstHour`/`lastHour` are bucket starts, not sensor measurement times. Model retrieval can occur after the requested historical window and recent estimates can change on later queries.

Dew point uses the Magnus approximation over liquid water (`a=17.625`, `b=243.04°C`) for each valid temperature/RH pair before indoor hourly averaging. RH=0 has no finite dew point and is omitted from that comparison, while zero temperature remains valid. Dew-point differences describe moisture more usefully than comparing relative humidity at different temperatures, but are approximate and are not ventilation advice or evidence that a window/heating change caused an observed trend.

After deployment: verify `weather_history` gains rows, check the 24-hour and seven-day dashboard views, refresh MCP discovery, and call `get_history_comparison`. Expect incomplete initial coverage rather than a full seven-day archive. No production migration or deployment is performed by the PR itself.

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

The dashboard shows current readings and selectable 24-hour or seven-day indoor history, with per-chart min/max values and freshness status. Daily indoor temperature summaries use browser-local calendar days, including daylight-saving transitions. Coverage counts distinct five-minute collection-time periods with an online, finite temperature, relative to the portion of each day inside the selected window. Missing days remain visible; partial days are labelled. Min/max values describe available samples, not guaranteed daily extremes. Outdoor overlays use the persistent archive over the selected window, with a paired-hour indoor/outdoor temperature and dew-point comparison table. Apply migration `0004_weather_history.sql` before deploying this outdoor history update.

### History read usage

Device discovery seeks the first device ID and then each ID greater than the previous one, using existing indexes. It needs no schema migration and retains stopped devices. History requests emit a `history_read_usage` log with the selected `range`, total `rowsRead`, `deviceRowsRead`, `queries`, and `metadataAvailable`. Counts come from D1 result metadata; if metadata is absent the flag is false and totals are incomplete. Logs contain no device identifiers or readings. Worker logs are enabled in Wrangler. Preview URLs do not support logs, so compare `24h` and `7d` read costs after production deployment; the measured old DISTINCT discovery query read 9,263 rows. Local SQLite query-plan tests verify indexed seeks but cannot establish D1 billed read counts.

Automatic history polling is limited to one attempt per five minutes per page, skips hidden tabs and avoids overlapping requests. Returning to a visible page fetches only when due. Changing the selected range fetches immediately, or after the current request finishes; intermediate range changes are coalesced. Failed attempts for the same range also wait until the next interval, limiting retries. Freshness labels continue to update without database reads. Live readings, weather polling and the scheduled collector are unchanged.


## MCP: indoor conditions, history, collection health and outdoor comparison

`POST /mcp` exposes five read-only tools through the
Cloudflare stateless MCP handler with Streamable HTTP and SDK legacy-client
compatibility. Authentication supports a shared bearer token for local/Inspector use and
Cloudflare Access signed assertions for Managed OAuth. Cloudflare owns OAuth
discovery, registration, consent and token issuance; the Worker validates the
assertion forwarded by Access. Real-client OAuth compatibility must be verified
during activation.

In the default bearer mode, the endpoint is disabled (404) unless
`MCP_AUTH_TOKEN` is a secret of at least 32 characters. A valid `Authorization: Bearer <token>` header is required for
all MCP requests, including discovery. Missing/incorrect credentials return 401;
cross-origin browser requests return 403. Tokens are compared via fixed-size
SHA-256 digests using a timing-safe comparison. No CORS access is enabled.
The default SDK Host checks protect local development against DNS rebinding.

`get_current_conditions` takes no arguments and returns:

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
performs no D1 queries or writes. Outdoor comparison reuses this indoor snapshot and the dashboard weather cache. Historical summaries and collection health
read D1 through the same authenticated endpoint; neither polls Govee.

### Outdoor comparison

`get_outdoor_comparison` takes no arguments and compares current indoor readings
with the same Open-Meteo local estimate used by the dashboard. Outdoor values are
**modelled local conditions, not balcony measurements**. It returns structured
content and matching JSON text, with Celsius temperatures and percent humidity.

- `outdoor` includes source attribution, location label, temperature, humidity,
  `fetchedAt` and `validAt` (Unix milliseconds), and `available`, `fresh`, `stale`
  and `refreshFailed` flags. Availability means a snapshot exists; individual
  metrics can still be null. Stale estimates remain labelled and visible.
- `indoor` includes snapshot availability, ISO retrieval time, the 30-second
  cache lifetime and the 90-second comparison freshness limit. Room entries
  retain opaque IDs, names, metrics, online status and ISO retrieval times.
- Each room adds `indoorFresh` and `temperatureDifference`: **indoor minus
  outdoor**, positive when warmer indoors. The difference is null unless the
  room is online, both temperatures are finite, the indoor snapshot is at most
  90 seconds old, and the outdoor estimate passes the dashboard freshness rules
  (fetch age at most 45 minutes, valid-time age at most 60 minutes, no failed
  refresh or future timestamps). Fresh timestamps do not establish sensor health.
- Indoor times describe Govee API retrieval, not sensor measurement. Top-level
  `retrievedAt` is the comparison response time; outdoor valid time is distinct
  from fetch time. These are not simultaneous indoor/outdoor measurements.
- If one source fails, the other is returned with explicit availability flags.
  An unavailable indoor source produces an empty rooms array; a successful empty
  discovery has `indoor.available=true`. Both sources failing produces a
  sanitized tool error. Missing metrics and valid zeros stay distinct.

The tool shares the existing internal indoor cache and D1 weather cache/15-minute
refresh lease with the dashboard. It may populate those caches, but does not change
sensor settings, collection schedules, history, authentication or database schema.
Dashboard comparisons use the same calculation. No ventilation recommendation is
inferred: relative humidity alone does not establish whether outside air would dry
the flat. Names and location labels are data, not instructions.

After deployment, refresh the client's tools and call `get_outdoor_comparison`
with `{}`. Compare it with the dashboard while both sources are fresh. Local
regression tests cover cache reuse, partial failures, timestamp boundaries,
missing metrics and the authenticated MCP response; live client verification
remains a post-deployment check.

### Historical summaries

`get_history_summary` defaults to the last 24 hours. Supply **both** `from` and
`to` for an overnight or custom interval, as ISO timestamps with `Z` or an
explicit UTC offset. The window must be positive, entirely within the last seven
days, and must not extend into the future. Clients resolve local dates and DST;
the server does not guess what “last night” means. For example:

```json
{"from":"2026-09-25T23:00:00+01:00","to":"2026-09-26T08:00:00+01:00"}
```

This example is valid only while it is inside the seven-day lookback. The summary
window is **[from, to)**: start inclusive, end exclusive. The chart history API
keeps its existing inclusive endpoints; the shared summary calculation excludes
samples exactly at `to`.

The compact result contains all known rooms as of the window end, with opaque
IDs and separate temperature/humidity statistics:

- Valid online sample count, observed min/max and arithmetic sample mean.
- First/last observed values and collection times; change is last minus first,
  not a claim about unsampled window endpoints. Change is null unless there are
  at least two distinct collection times. Humidity change is in percentage points.
- Observed/expected five-minute UTC collection periods and coverage percentage.
  Partial edge periods each count once. Multiple readings in one period count
  once towards coverage but remain individual samples for min/max/mean.
- Longest consecutive run of periods without a valid reading, including leading
  and trailing gaps. This is a period count, **not a measured duration**.

Missing, offline and unknown readings are excluded per metric; zero remains
valid. Empty room windows return null statistics and zero coverage. Scheduled
slot replays cannot inflate coverage, which uses actual collection time.
Gaps are unknown conditions and can hide extremes; there is no interpolation,
threshold-duration estimate or comfort classification. Output timestamps
`from`, `to`, `firstCollectedAt` and `lastCollectedAt` are Unix milliseconds;
`retrievedAt` is the ISO query time. None is a sensor measurement timestamp.

The dashboard's **Selected period summary** uses this exact calculation on
already-loaded history, for both 24-hour and seven-day views, with no additional
API calls. Daily temperature summaries and charts remain available below it.

### Collection health

`get_collection_health` takes no arguments and reads the latest stored collection
metadata plus last-24-hour coverage. It retains stopped rooms and reports:

- Last collection and last valid reading (online with both metrics present).
- Separate stale flags using the existing ten-minute threshold.
- Last recorded status: online, offline, unknown or incomplete. This is not a
  live sensor check, and a recent collection can contain an offline reading.
- Overall collection recency: `no_data`, `no_recent_collections`,
  `some_rooms_stale` or `recent_collections`. The last means collections are
  recent, not that every sensor is healthy.

Stored history alone cannot establish whether missing collections result from
cron failure, an upstream error or a disconnected device. Both tools return
sanitized tool errors when D1 is missing/unavailable, and empty successes when
storage is empty. They use existing indexed history queries and aggregate read
telemetry, without a database migration, new Govee requests or auth changes.
History queries remain uncached and bounded to seven days; collection health
reads 24 hours. Logs label custom summary queries with `range: "custom"`.

After deployment, refresh/reconnect the client's tool list, ask about the last
24 hours and a local overnight interval, then compare with the dashboard. Check
collection health separately. Live client validation and production D1 read-cost
verification remain deployment checks; local tests use SQLite and mocked auth.

### Local verification

1. Run `npm ci` and `npm test`. `npx wrangler deploy --dry-run` checks the Worker
   bundle without deploying. CI runs both tests and the dry-run build.
2. Set `MCP_AUTH_MODE=bearer` and add `MCP_AUTH_TOKEN` in the ignored `.dev.vars`
   file alongside `GOVEE_API_KEY`, overriding the committed Access mode locally.
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

### Managed OAuth through Cloudflare Access

Select one authentication mode with `MCP_AUTH_MODE`:

| Mode | Required configuration | Accepted credential |
| --- | --- | --- |
| `bearer` (default) | `MCP_AUTH_TOKEN`, at least 32 characters | Matching Authorization bearer token; Access remains an additional edge gate |
| `access` | `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUD` | Verified `Cf-Access-Jwt-Assertion` from Access |
| `disabled` or any unrecognised value | None | Endpoint returns 404 |

Incomplete or invalid mode-specific configuration returns 404. Access mode
never falls back to the bearer secret, even if one remains configured.
`wrangler.jsonc` commits the production Access mode, team origin and application
AUD so deployments preserve the working authentication configuration. These
values are not secrets; the Govee API key remains a Cloudflare secret.

Deployments using this configuration, including version preview uploads, require
an assertion from the configured production Access application. Previews protected
by a different Access application will reject its audience; configure those
environments separately or set `MCP_AUTH_MODE=disabled` for them.

On 26 September 2026, Claude successfully connected through Managed OAuth,
discovered `get_current_conditions`, and returned readings matching the dashboard
for all three rooms. Token refresh and rejection of users outside the Access
allowlist remain separate live checks. Managed OAuth, callback URIs and Access
policies are configured in Cloudflare Zero Trust, not in Wrangler.

`MCP_ACCESS_TEAM_DOMAIN` must be the exact HTTPS team origin, for example
`https://your-team.cloudflareaccess.com`, without a trailing slash or path.
`MCP_ACCESS_AUD` is the **Application Audience (AUD) Tag** of the Access
application protecting this Worker, not its application ID or account ID.
Both are configuration variables, not secrets. Get the actual values from
Zero Trust; do not deploy example values. Configure them durably in Wrangler
or your deployment configuration so future deployments retain them.

Access mode uses `jose` to validate RS256 signatures, issuer, application
audience, expiry and not-before time when present. Expiry, issued-at and a
nonempty subject are required; future issued-at times are rejected. The only
key source is the configured team's `/cdn-cgi/access/certs` endpoint. JWT
headers/claims cannot choose another key URL. JWKS resolvers are cached per
issuer with a five-minute cache, 30-second refresh cooldown and five-second
fetch timeout. Invalid assertions and key-fetch failures fail closed with a
generic 401; tokens and validation error details are never logged.

Cloudflare Managed OAuth gives the client an **opaque OAuth token**, then
resolves it at the edge and forwards a signed JWT assertion to the Worker.
The Worker deliberately does not interpret that opaque bearer value as a JWT
or accept an unverified email header. Existing Access policies determine who
may access the application; retain the household allowlist and do not add
bypass policies. An authenticated browser can also supply a valid Access
assertion: this mode authenticates Access users, not only OAuth sessions.

### Staged activation for a new installation

1. Set `MCP_AUTH_MODE=disabled` before the initial deployment. Verify the dashboard and its refresh,
   and confirm `/mcp` shows 404 after Access login.
2. Verify Access protects the intended production hostname and all enabled
   preview/alternate URLs. Keep preview activation separate: a different Access
   application has a different audience. Do not copy production auth settings
   to previews blindly.
3. Set the actual team origin and application AUD, then set `MCP_AUTH_MODE=access`
   last. This is an activation step: authenticated Access users can now reach
   MCP, including through existing browser sessions. No shared MCP secret is
   needed in this mode.
4. In **Zero Trust → Access controls → Applications → the protecting application
   → Edit → Advanced settings**, enable **Managed OAuth**. Restrict redirect
   URIs to those required by the chosen client. Enable localhost/loopback
   callbacks only if the test client needs them. Leave the existing Access
   identity policy in place.
5. Test OAuth discovery and browser sign-in with an RFC 8707-capable MCP client,
   then list tools and call `get_current_conditions`. Compare its values and
   retrieval times with the dashboard. Verify unauthenticated access prompts
   for authentication, and a user outside the allowlist cannot connect. Test
   reconnect/token refresh before treating the integration as complete.

Cloudflare supplies discovery and OAuth endpoints at the edge; do not add
Worker-owned OAuth routes or bypass Access to make discovery work. The Worker
401 is a generic rejection for requests that reach it without a valid assertion;
it is not a replacement OAuth discovery implementation. Client registration,
redirect URIs and browser Origin behaviour still require a real-client test.

Rollback: set `MCP_AUTH_MODE=disabled` to close the tool endpoint, while keeping
Access protection. Turning off Managed OAuth alone does not disable access
through existing authenticated browser sessions. No database migration is needed.

Tests use locally generated RSA keys and a mocked JWKS endpoint to exercise
real signature/claim verification, discovery and tool calls, invalid config,
forged/expired/wrong-audience tokens, denied origins and key-fetch failure.
They do not establish live Access policy correctness or client compatibility.

References: [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).


### Window guidance

`GET /api/ventilation` and the read-only MCP tool `get_ventilation_guidance({})`
return the same assessment used by each dashboard room card. Cards show a compact
conclusion with essential trade-offs; expandable details contain dew points and
supporting reasons. Expansion and keyboard focus survive polling. No new secrets,
configuration or database migration are required. Refresh MCP tools after deployment.

The response includes per-room `status`, `summary`, `reasons`, `cooling`, `drying`,
indoor/outdoor dew points and signed indoor-minus-outdoor differences (°C).
`validUntil` is an expiry, not a forecast. All numeric timestamps are Unix milliseconds.
Outdoor provenance and freshness are included. Source failures are independent;
missing history produces uncertain guidance, and missing/invalid/stale current
inputs produce unavailable guidance. Total current-source failure returns HTTP 503
or a sanitized MCP error. Room names remain untrusted data.

Rules live in `src/ventilation.js` and use the existing Magnus dew-point function.
Defaults are preference thresholds of >25°C, <40% or >60% RH, with no lower
comfortable temperature configured. Temperature and dew-point margins are both
2°C; these are conservative provisional product choices, not validated sensor
error bounds. Cooling of at least 5°C is described as substantial where it is a
trade-off. RH=0 cannot yield a finite dew point and suppresses guidance.

A conclusion must also agree with the last two distinct indoor collections in
12 minutes, at least four minutes apart, with the latest no older than seven
minutes. Invalid/offline samples interrupt confirmation. These stored readings
are compared with the **current** outdoor estimate, so this is indoor confirmation,
not evidence of outdoor stability or a causal effect of opening a window. This
avoids counting repeated cached API calls as independent readings. Threshold
crossings temporarily yield uncertainty until confirmed; no process-local state
or client-specific hysteresis is used. The short history read uses existing
per-device time indexes and does not fetch the outdoor archive.

The UI refreshes guidance after its indoor fetch, reusing the 30-second current
cache and weather cache. It clears guidance on refresh failure and checks expiry
between polls. A versioned service-worker cache ships the new UI module. Dashboard
API access continues to rely on the existing Cloudflare Access application, and
MCP keeps its existing endpoint authentication.

This is temperature/moisture comfort guidance, not a CO2, air-quality, condensation
or safety assessment. It does not prescribe window duration, predict final room
humidity, or infer that a window is open. Drying and cooling can conflict. Even
when drying succeeds, relative humidity can temporarily rise as air cools.
