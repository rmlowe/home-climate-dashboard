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

Prerequisites: Node.js and npm.

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

## Current scope

Version 1 shows current readings. Possible later additions include historical charts, min/max values, comfort indicators, custom domains, and temperature/humidity alerts.
