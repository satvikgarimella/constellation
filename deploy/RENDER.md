# Deploy on Render Free

This configuration runs the existing Node server on one Render web service. Render provides HTTPS and forwards `/ws` to the same server. Browsers still do the rendering. These instructions and `render.yaml` prepare deployment; they are not evidence of a live service.

## Create the service

Use a **Hobby workspace** and **Free compute**, with **no payment method**. The repository's [render.yaml](../render.yaml) explicitly selects `plan: free`, one instance, and manual deploys. It creates no database, disk, or other resource. Review the creation screen before applying it. [Render free services](https://render.com/docs/free), [Blueprint fields](https://render.com/docs/blueprint-spec)

In the [Render dashboard](https://dashboard.render.com/), create a Blueprint from this repository and select `main`. Alternatively, create a Web Service from the repository with these settings:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Region | Ohio |
| Compute plan | Free |
| Build command | `npx --yes pnpm@11.25.0 install --prod --frozen-lockfile` |
| Start command | `PUBLIC_URL="${PUBLIC_URL:-$RENDER_EXTERNAL_URL}" node --env-file-if-exists=/etc/secrets/constellation.env server/index.js` |
| Health check | `/healthz` |
| Auto-deploy | Off |
| `NODE_VERSION` | `24.22.1` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `DATA_DIR` | `./data` |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |

Leave `PORT` platform-managed. There is no frontend build step. The start command uses Render's generated HTTPS address for QR codes and sharing; set `PUBLIC_URL` explicitly only if using a different configured HTTPS domain. [Node versions](https://render.com/docs/node-version), [default environment variables](https://render.com/docs/environment-variables), [WebSockets](https://render.com/docs/websocket)

Enter `GEMINI_API_KEY` and `DATABASE_URL` privately in Render's environment settings. The Blueprint prompts for these values with `sync: false`; no credentials are stored in Git. Use the existing database connection string with `sslmode=verify-full`, retaining certificate verification. Presets work without these optional integrations. Their providers' quotas and charges remain separate from Render. [Environment variables and secrets](https://render.com/docs/configure-environment-variables)

For CLI deployment, the same credentials can be uploaded as a Render secret file named `constellation.env`. The start command reads it from `/etc/secrets/constellation.env` if present. Include only `GEMINI_API_KEY` and `DATABASE_URL` in this file; keep host, port, and public URL in the service configuration. This keeps secret values out of command-line arguments. Never commit the secret file.

## Verify the deployed URL

After Render reports **Live**, substitute its actual URL and run from the matching local checkout:

```sh
BASE_URL=https://YOUR-SERVICE.onrender.com MATCH_LOCAL_ASSETS=1 node scripts/verify-deployment.mjs
```

This verifies HTTPS, health, served browser assets, room creation, QR output, and two simultaneous WebSocket connections. To additionally require configured Gemini and a ready database, set `REQUIRE_GEMINI=1 REQUIRE_TIGER_DATA=1`. Configuration checks do not make real Gemini calls or prove database writes; use the live integration tests for those.

Open the deployed root URL on the laptop to create a new Host tab. Invite phones with that room's QR code and complete a render. Existing temporary-tunnel rooms cannot migrate to this server. Keep the original Host tab open; copying its room link into another tab does not transfer host permissions.

## Free-plan limits

- Idle services sleep after 15 minutes without inbound HTTP requests or WebSocket messages. Waking takes about one minute. Open the site before the demo. A restart, redeploy, or sleep clears this app's in-memory rooms and local telemetry files. Tiger Data telemetry already written remains in that database. [Free service behavior](https://render.com/docs/free)
- The workspace receives 750 free instance-hours per month. Free compute has 0.1 CPU and 512 MB RAM. Run one small supervised room first; the app's 100-session limit is not a hosted capacity guarantee. [Free hours](https://render.com/docs/free), [compute plans](https://render.com/docs/compute-plans)
- Hobby includes 5 GB outbound bandwidth per month. WebSocket output counts, and this app sends each completed image tile to every participant. For example, a 1024 × 1024 RGBA image sent to 33 sessions uses about 138 MB for pixel payload alone, before other messages. Without a payment method, reaching the allowance suspends services instead of billing overages. [Bandwidth allowance](https://render.com/docs/outbound-bandwidth)
- Hobby includes 500 build minutes per month. Without a payment method, exhausting them pauses new builds. Manual deploys avoid interrupting an active demo on every Git push. [Build allowance](https://render.com/docs/build-pipeline)

Finish active renders before a manual deployment. Every deployment starts a new coordinator; create a fresh host room and reinvite contributors afterward. Do not scale this app to multiple instances while its room state remains in process memory.
