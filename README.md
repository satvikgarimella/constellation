# Constellation

**Turn a room of browsers into a shared render farm.** Participants scan a QR code, opt in, and calculate separate tiles of a path-traced image. The studio assembles their pixels live, shows each device's contribution, and reassigns unfinished work when someone leaves.

This is a working hackathon prototype for collaborative rendering and teaching distributed systems. It supports its own sphere-and-ground scene format. It is not a Blender renderer or a general-purpose distributed GPU.

## Run locally

Requires Node.js 22.9+ (24 recommended). Dependencies are already installed in this checkout.

```sh
cd constellation-render
node --env-file-if-exists=.env server/index.js
```

Open **http://localhost:3210**. Click **Contribute compute**, then **Start render**. The server binds to your local network so another device can join using the QR code.

For a fresh checkout, install first:

```sh
corepack pnpm install --frozen-lockfile
```

Or use `npm install` if pnpm/Corepack is unavailable. `npm start`, `npm test`, and `npm run dev` are aliases for the corresponding Node commands. There is no frontend build step.

If your shell's npm wrapper fails, use the direct Node start command above. It does not need npm once dependencies are installed.

## First demo

1. Open the studio on a laptop, contribute, and run **512 × 512 / 32 samples** solo. The completed run becomes a baseline.
2. Select **Invite devices**. Scan the QR on two or more devices, name them, and opt in. Keep their pages visible.
3. Repeat the **same scene and settings**. Toggle **Contribution map** to show who rendered each tile. The completed-run comparison uses actual elapsed time.
4. Try **1024 × 1024 / 128 samples** for a longer live demo. While rendering, close one contributor's tab. Watch the reassignment count and remaining devices finish the image.
5. Download the image using the arrow button above the canvas.

Use separate physical devices for a meaningful crowd benchmark. Two browser contexts on one computer test coordination but share hardware. Render speed is affected by scene geometry, temperature, device speed, network latency, and UI work. This project makes no claim to beat a dedicated desktop GPU.

## GPU and phone access

- The default renderer is **WebGPU**, with a WGSL compute shader that traces rays on the device's GPU.
- WebGPU needs a secure context. `localhost` works for local development; phones joining `http://<LAN-IP>` use the **CPU Web Worker** fallback. Deploy with HTTPS to exercise supported phones' GPUs.
- Browsers and device capabilities differ. The interface reports the backend actually selected. Add `?cpu=1` to force the compatibility renderer for testing.
- Contributions pause when the page is hidden, resume on return, and stop immediately when the user chooses Pause. A wake lock is requested where supported.
- Some venue Wi-Fi networks isolate devices. Use a reachable HTTPS deployment or a shared hotspot if the local QR cannot connect.
- If multiple LAN interfaces are present, set `PUBLIC_URL` to the reachable address before starting; this controls the QR link. Do not use `localhost` in links shared to phones.

## Optional AI and telemetry

Copy `.env.example` to `.env`, fill the desired values, then restart the server. Never put API keys in frontend files or commit `.env`.

### Gemini scene generation

Set `GEMINI_API_KEY`. The host can describe a composition; Gemini returns structured JSON containing geometry, materials, camera, and lighting. The server bounds and validates it before sending it to the renderers. The model does not return executable JavaScript or WGSL.

The default is `gemini-3.8-flash`, configurable with `GEMINI_MODEL`. This uses the `generateContent` endpoint with `responseJsonSchema`; see Google's [API reference](https://aistudio.google.com/api-reference/generate-content) and [model migration documentation](https://aistudio.google.com/docs/whats-new-gemini-3.8). The scene vocabulary is deliberately limited to spheres and a ground plane, so prompts are abstract compositions rather than arbitrary 3D models.

No key is bundled. The adapter has automated tests using simulated API responses; a live call still needs your key and available model/quota.

### Tiger Data / Postgres

Set `DATABASE_URL` to your database's connection string, including its required TLS parameters. The server creates `render_events`, adds a room/time index, and attempts to turn it into a Timescale hypertable when that extension is available. Ordinary Postgres also works.

Events include server timestamps, room/run/worker IDs, accepted tiles, observed turnaround, reported compute time, pixel count, and backend. `/api/rooms/:id/metrics` queries per-worker totals and per-second completion counts. The dashboard displays the database query totals when connected; the live sparkline remains the coordinator's run-average throughput.

Local telemetry is always written to `data/events.jsonl`. Database writes are batched; unavailable databases are retried. The in-memory retry queue is bounded at 10,000 events, while the JSONL remains the complete local log. Database writes are best effort: an uncertain connection failure can produce duplicate analytics records; billing or verified credit accounting is outside scope.

No hosted database is connected in this checkout. Recovery behavior is tested with a simulated connection.

## Deploy on a VM with HTTPS

`Dockerfile` and `deploy/` provide a single Node coordinator behind Caddy. The same setup can be deployed on Vultr or another Docker-capable VM. Docker is not installed in the development environment, so these deployment files have not been built or deployed here.

1. Point a domain's DNS record at the VM. Allow inbound TCP 80 and 443 (UDP 443 optional).
2. Copy this project to the VM. Create `.env` from `.env.example`; add `DOMAIN=render.your-domain.com` and optional service credentials.
3. From the project root, run:

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build -d
docker compose --env-file .env -f deploy/compose.yaml logs -f app caddy
```

4. Open the HTTPS domain, create a room, and test a phone before the presentation.

Caddy handles HTTPS and forwards WebSockets. The app port is internal to the Docker network. Telemetry and certificates use persistent volumes. Run **one app instance**: room state, host permissions, leases, and pixel caches are in memory. Restarting the server expires rooms; telemetry persists.

## Architecture

```text
Studio host ── start(scene, settings) ──► Node coordinator
                                          │
Phone / laptop ◄── tile + scene + lease ────┤
   Web Worker                             │
   ├─ WebGPU compute shader               │
   └─ CPU reference renderer              │
         │                                │
         └── binary RGBA tile ───────────►├──► All viewing canvases
                                          └──► JSONL / optional Postgres
```

`public/scene.js` defines scene validation, deterministic per-pixel seeding, tiles, and the result protocol. `public/raytracer.js` and `public/trace.wgsl` implement the same rendering algorithm. `public/render-worker.js` chooses the backend. `server/coordinator.js` owns all scheduling; the server never calculates the rendered pixels.

Each worker receives one tile at a time. Faster workers naturally request more. Jobs have a worker identity, run ID, and unique lease. A pause, disconnect, or 30-second deadline returns unfinished work to the queue. Stale, duplicate, malformed, or wrong-worker result frames are rejected. Late viewers receive the cached image and contribution map.

The host capability token stays in that browser tab's session storage and is not included in shared URLs. Keep that tab for the demo; opening only the room URL in a different browser gives viewing and contributing access, not host controls.

## Tests

```sh
node --test test/*.test.js
```

The suite covers deterministic tile assembly, valid scene bounds, binary framing, scheduling fairness, disconnects/timeouts, owner authorization, stale/duplicate results, cancelled runs, late-viewer replay, real HTTP/WebSocket rendering, JSONL events, database recovery, and Gemini response handling.

Optional browser tests require Playwright and Chromium:

```sh
npm install --no-save playwright
npx playwright install chromium
# Start the app in another terminal first.
node test/browser.mjs
node test/webgpu.mjs
```

`BASE_URL` overrides the default `http://localhost:3210`. If Playwright is provided by your environment, `PLAYWRIGHT_MODULE` can be the absolute path to its `index.mjs`. Screenshots, rendered PNGs, and reports are saved under `artifacts/` (gitignored).

The ordinary browser test covers real Worker rendering in two contexts, solo/multi-run comparison, PNG download, disconnect recovery, late-viewer canvas equality, and mobile layout. It reports GPU availability without pretending a fallback is a GPU.

The dedicated WebGPU test **requires** a GPU backend, validates shader execution, and compares the resulting image with the CPU reference. For headless Chromium on this Mac, explicit backend flags were needed:

```sh
GPU_ARGS='["--enable-unsafe-webgpu","--use-angle=metal"]' node test/webgpu.mjs
```

These are test-browser flags, not instructions for audience phones. Normal visitors use their browser's supported default configuration.

## Scope and next improvements

- A render contains 1–12 spheres and a plane, up to 1024 × 1024 pixels and 128 samples. There are no mesh uploads, animations, transparent materials, or arbitrary jobs.
- It trusts the contents of accepted pixels. Lease validation prevents accidental duplicates and stale work; it does not prove computation was honest. No payments or rewards are involved.
- Participant data is limited to chosen display names and computation metrics. Room IDs are shareable, so avoid sensitive content.
- The room/client caps, bounded settings, origin checks, and payload limits suit a supervised demo. This is not a hardened public compute marketplace.
- CPU and GPU implementations have small floating-point differences. A mixed-backend render can have slight differences in noise. Use matching backends for benchmark comparisons.
- The AI and database integrations need real credentials, and physical-phone/browser compatibility needs rehearsal on the actual devices.

See `HACKATHON.md` for sponsor fit, the team split, and a three-minute demo script.
