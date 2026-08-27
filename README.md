# Home Climate Dashboard

A small private-use web dashboard for displaying current temperature and humidity readings from Govee H5179 thermo-hygrometers.

The app is designed for Cloudflare Workers. Static HTML/CSS/JavaScript is served alongside a Worker API endpoint that talks to the official Govee OpenAPI. The Govee API key is stored as a Cloudflare secret and is never sent to the browser or committed to GitHub.

## Architecture

```text
Browser
   |
   +-- GET / --------------------> static dashboard
   |
   +-- GET /api/readings --------> Cloudflare Worker
                                      |
                                      +--> Govee OpenAPI
```

The Worker discovers compatible thermometer devices, fetches their current state in parallel, converts the observed H5179 Fahrenheit readings to Celsius, and returns a small JSON response. The complete response is cached at the Worker for 30 seconds to avoid unnecessary Govee API calls.

## Local development

Prerequisites: Node.js and npm.

```bash
npm install
npx wrangler secret put GOVEE_API_KEY
npm run dev
```

For local-only development, you can instead create a `.dev.vars` file containing:

```text
GOVEE_API_KEY=your-key-here
```

`.dev.vars` is excluded by `.gitignore`; never commit it.

The H5179 units used for this project currently return `sensorTemperature` in Fahrenheit. `wrangler.jsonc` therefore sets `GOVEE_TEMPERATURE_UNIT` to `fahrenheit`, and the Worker converts the value to Celsius before returning it to the browser.

## Deploy

Authenticate Wrangler with Cloudflare, then add the API key as an encrypted secret:

```bash
npx wrangler login
npx wrangler secret put GOVEE_API_KEY
npm run deploy
```

The initial deployment can use the generated `*.workers.dev` hostname. A custom domain and Cloudflare Access can be added afterwards.

## Security

- `GOVEE_API_KEY` is read only by the Worker.
- No device identifiers are returned to the browser.
- `.dev.vars` and other local secret files are ignored by Git.
- The dashboard should be protected with Cloudflare Access before treating it as a permanent household service.

## Current scope

Version 1 deliberately shows only current readings. Possible later additions include historical charts, min/max values, PWA installation, comfort indicators, and temperature/humidity alerts.
