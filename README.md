# Constellation

**Turn a room of browsers into a shared render farm.** Participants scan a QR code, opt in, and calculate separate tiles of a path-traced image. The studio assembles their pixels live, shows each device's contribution, and reassigns unfinished work when someone leaves.

This is a working hackathon prototype for collaborative rendering and teaching distributed systems. Its scene format supports spheres, boxes, dune terrain, and procedural skies. It is not a Blender renderer or a general-purpose distributed GPU.

## Hosted demo

Open **[constellation-render.onrender.com](https://constellation-render.onrender.com)** on your laptop to create a host room. Select **Invite devices**, have contributors scan the QR and opt in, then choose a preset and **Start render**. The coordinator runs on Render independently of your laptop; keep the host tab open to control that room.

The service uses Render Free in a Hobby workspace. An idle service can take about a minute to wake, and restarts clear rooms. Start with a small room and modest resolution because image traffic counts against the free bandwidth allowance. Gemini generation and database analytics require their server-side credentials. See the [Render deployment guide](deploy/RENDER.md) for configuration, limits, and verification.

## Run locally

Requires Node.js 22.9+ (24 recommended). Dependencies are already installed in this checkout.

```sh
cd constellation-render
node --env-file-if-exists=.env server/index.js
```

Open **http://localhost:3210**. Click **Contribute compute**, choose **Quick check**, then **Start render**. New rooms start with **Aurora Desert**. The original **Orbit** scene is also available: a chrome core, 50 orbiting beads, emissive accents, and a reflective floor. Every visible result is calculated by the contributing browsers.

Try **Aurora Desert** for rolling dune geometry under a procedural aurora and stars, or **Neon City** for solid towers, glowing facade bands, and reflected light. Terrain and boxes work in both the WebGPU and CPU renderers. The aurora is an analytic sky effect that appears in reflections; it is not a volumetric atmospheric simulation. Selecting a preset or generating a scene marks it **SCENE READY**. Press **Start render** to calculate its image.

For a fresh checkout, install first:

```sh
corepack pnpm install --frozen-lockfile
```

Or use `npm install` if pnpm/Corepack is unavailable. `npm start`, `npm test`, and `npm run dev` are aliases for the corresponding Node commands. There is no frontend build step.

If your shell's npm wrapper fails, use the direct Node start command above. It does not need npm once dependencies are installed.

## Share an HTTPS demo with phones

The share launcher starts the app and a temporary Cloudflare Quick Tunnel. It prints an HTTPS address and updates the QR link automatically. No Cloudflare account or domain is needed. Install `cloudflared` on macOS with the [official installation instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/):

```sh
brew install cloudflared
```

Stop any standalone app process using port 3210, then run from the project root:

```sh
node --env-file-if-exists=.env scripts/share.mjs
# Equivalent: npm run share
```

Open the printed **Public studio** HTTPS link on the laptop to create the host room. Use that room's **Invite devices** QR on the phones. They only need internet access; they can use different Wi-Fi networks or cellular data. Keep the original host tab open: its access is stored in that tab's session storage for the site address where you created the room. `/r/ROOM_CODE` opens the studio; `/join/ROOM_CODE` opens the contributor page. If the original host tab reaches a contributor page, choose **Open host controls** to return to the studio. Opening the room link in a new tab or browser does not by itself grant ownership.

Keep the share terminal and laptop running. **Ctrl-C stops both the app and tunnel.** The URL is temporary, changes on the next launch, and has no uptime guarantee. Anyone with the URL can reach the app. [Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

The page and browser tab show **Host** or **Viewer** after connecting. If scene controls are disabled in a viewer tab, return to the original **Host** tab or choose **Create my own studio**. That action creates a separate room, so invite the phones again. A host can select scenes before devices join; starting a render also requires at least one device to click **Contribute compute**.

The launcher uses `CLOUDFLARED_BIN` when set, otherwise a local `.tools/cloudflared` binary when present, otherwise `cloudflared` on `PATH`. `.tools/` is gitignored. It uses its own empty tunnel configuration and saves the current address in `data/demo-url.json`; an old file does not mean its tunnel is still running.

## First multi-device demo

1. Open the HTTPS studio on the laptop and keep its contribution paused to use it as the controller. The host can still start renders.
2. Select **Invite devices**. On two or more phones, scan the QR, choose distinct names, and tap **Contribute compute**. Keep their pages visible. Check the actual **WEBGPU** or **CPU WORKER** tag on each device.
3. Choose **Orbit** and **Quick check** (**256 × 256 / 8 samples**), then **Start render**. Confirm the image reaches 100% and each participating worker completes tiles. Toggle **Contribution map** to see their work.
4. Choose **Live demo** (**1024 × 1024 / 128 samples**). Under the image, choose a **Solo device** and click **Compare 1 vs crowd**. It runs the scene once on that device, then automatically repeats the same workload using the ready devices with the same renderer. Other devices wait during the solo run; the selected solo device also participates in the crowd run.
5. Read the measured result below the image. The comparison reports slower results too. Repeat longer workloads for more useful timings; very short runs are dominated by overhead. Download the JSON benchmark report with the arrow beside the comparison button.
6. For the recovery demo, start a separate longer render and close one contributor's tab while it has work. **Recovered tiles** should increase, and the remaining devices should finish the image. Use **Present** to enlarge the image for the audience; **Escape** restores the editing view.
7. Download the rendered PNG with the arrow above the image. **Poster** selects **2048 × 2048 / 256 samples**, and the quality selector supports up to **512 samples** for a heavier workload.

Use separate physical devices for a meaningful crowd benchmark. Several browser contexts on one computer test coordination but share hardware. Timings include networking and browser overhead; scene geometry, device speed, and temperature also affect results. More devices do not guarantee a speedup. The displayed throughput is completed pixel-samples per second, not a count of every secondary ray traced.

The app supports more than two participants. A room accepts **100 connected browser sessions total**, including the host and spectators: one host leaves room for up to 99 phone sessions. Each open tab counts separately. This is a connection limit, not a guarantee that 99 phones will render efficiently. The coordinator broadcasts every completed tile to all connected viewers, so network traffic grows with the audience. Start with two physical phones, then increase the group and measure the same workload. Use **Live demo** for larger groups; **Quick check** has only 64 tiles and initially supplies at most 16 workers with four-tile batches.

For an operator-controlled rehearsal, run `node scripts/phone-test.mjs https://YOUR-DEMO-ORIGIN`. It prints a fresh join link, waits for two opt-in participants, renders a quick shared image, then runs three matching solo/crowd pairs. Keep both pages open. It writes `artifacts/phone-test-report.json`; paused/disconnected devices, mixed renderers, and incomplete tests are reported rather than counted as passes. The operator must confirm that the participants really are on separate physical phones. The controller itself does no rendering.

## GPU and phone access

- The default renderer is **WebGPU**, with a WGSL compute shader that traces rays on the device's GPU.
- WebGPU needs a secure context. `localhost` works for local development; phones joining `http://<LAN-IP>` use the **CPU Web Worker** fallback. Use the HTTPS share launcher or an HTTPS deployment to exercise supported phones' GPUs.
- Browsers and device capabilities differ. The interface reports the backend actually selected. Add `?cpu=1` to force the compatibility renderer for testing.
- Contributions pause when the page is hidden, resume on return, and stop immediately when the user chooses Pause. A wake lock is requested where supported.
- Some venue Wi-Fi networks isolate devices. The public HTTPS link avoids the need for peer access on that Wi-Fi, but the laptop must remain connected to the internet.
- For a permanent deployment, set `PUBLIC_URL` to its HTTPS address before starting. The temporary share launcher sets the address automatically. Do not use `localhost` in links shared to phones.
- Physical-phone compatibility and real crowd speedup still need rehearsal on the actual devices. The automated browser tests use multiple contexts on one computer.

## Optional AI and telemetry

Copy `.env.example` to `.env`, fill the desired values, then restart the server. Never put API keys in frontend files or commit `.env`.

See [SETUP.md](SETUP.md) for the account links, free options, and where to copy each value. After saving the credentials, verify real service calls:

```sh
node --env-file-if-exists=.env scripts/verify-services.mjs
```

Use `--gemini` or `--database` to check only one. The verifier saves sanitized results in `artifacts/service-verification.json` and exits unsuccessfully for missing credentials or failed requests. It makes a real Gemini request and writes/reads one tagged synthetic database event; that row remains in the database. A passing database check establishes PostgreSQL functionality, not the identity of its hosting provider.

For the complete Gemini UI path, start the configured app and run `node test/services-live.mjs` with the same Playwright/WebGPU settings as the browser tests below. This opt-in test makes up to two real generation requests, validates the generated scene, renders it on WebGPU, compares the pixels with the CPU reference, and saves `artifacts/gemini-ui-report.json` plus a screenshot. It does not claim database verification.

For the database UI path, wait until `/api/config` reports `databaseReady: true`, then run `BASE_URL=https://YOUR-DEMO-ORIGIN node test/services-database-live.mjs` with the same Playwright/WebGPU settings. This opt-in test creates a fresh room, renders 64 real GPU tiles, and checks that the database metrics return exactly 64 tiles and 65,536 pixels for the actual contributor. It saves `artifacts/database-ui-report.json` and a screenshot, and leaves the test room's telemetry in the configured database. It makes no Gemini requests and does not establish physical-phone performance.

### Gemini scene generation

Set `GEMINI_API_KEY`. The host can describe a composition; Gemini returns structured JSON containing geometry, materials, camera, and lighting. The server bounds and validates it before sending it to the renderers. The model does not return executable JavaScript or WGSL.

The default is `gemini-3.8-flash`, configurable with `GEMINI_MODEL`. This uses the `generateContent` endpoint with `responseJsonSchema`; see Google's [API reference](https://aistudio.google.com/api-reference/generate-content) and [model migration documentation](https://aistudio.google.com/docs/whats-new-gemini-3.8). Gemini can compose spheres, solid boxes, dune terrain, aurora, and a starry sky, including the camera, materials, and lighting. Try “a desert with northern lights” or “a neon city skyline reflected in a dark plaza.” Generated geometry is limited to 24 spheres and 32 boxes. Detailed arbitrary meshes, text, and image textures are not implemented; other objects are approximated using the supported geometry and described as such.

No key is bundled. The adapter has automated tests using simulated API responses; a live call still needs your key and available model/quota.

### Tiger Data / Postgres

Set `DATABASE_URL` to your database's connection string, including its required TLS parameters. The server creates `render_events`, adds a room/time index, and attempts to turn it into a Timescale hypertable when that extension is available. Ordinary Postgres also works.

Events include server timestamps, room/run/worker IDs, accepted tiles, observed turnaround, reported compute time, pixel count, and backend. `/api/rooms/:id/metrics` queries per-worker totals and per-second completion counts. The dashboard displays the database query totals when connected; the live sparkline remains the coordinator's run-average throughput.

Local telemetry is always written to `data/events.jsonl`. Database writes are batched; unavailable databases are retried. The in-memory retry queue is bounded at 10,000 events, while the JSONL remains the complete local log. Database writes are best effort: an uncertain connection failure can produce duplicate analytics records; billing or verified credit accounting is outside scope.

No database credentials are bundled. Recovery behavior is tested with a simulated connection; use the service verifier and opt-in database UI test above to verify your configured hosted service.

## Deploy on a VM with HTTPS

`Dockerfile` and `deploy/` provide a single Node coordinator behind Caddy. The same setup can be deployed on Vultr or another Docker-capable VM. Docker is not installed in the development environment, so these deployment files have not been built or deployed here.

The full [Vultr deployment guide](deploy/DEPLOYMENT.md) includes sizing, source pinning, verification, updates, and rollback. Verify a deployed origin with `BASE_URL=https://YOUR-DOMAIN MATCH_LOCAL_ASSETS=1 node scripts/verify-deployment.mjs`. Its HTTPS/WebSocket checks do not substitute for rendering on the actual phones or calling the sponsor services.

1. Use the VM's stable public IPv4, or point a hostname's DNS record at the VM. Allow inbound TCP 80 and 443 (UDP 443 optional). A domain purchase is optional; the supplied Caddy configuration requests publicly trusted short-lived IP certificates.
2. Copy this project to the VM. Create `.env` from `.env.example`; set `DOMAIN` to the actual public IPv4 or hostname, without `https://`, and add optional service credentials.
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

Each browser opts into batches of up to four tiles, sharing the scene once per batch to reduce network round trips. It renders those tiles sequentially and returns each result immediately. A drained batch gets more work, so faster workers naturally receive more. Older clients keep single-tile behavior; append `?batch=1` to a joining browser URL to measure that mode. Jobs have a worker identity, run ID, and unique lease. A pause, disconnect, or 30-second period without accepted progress releases every unfinished tile in the batch. Stale, duplicate, malformed, or wrong-worker result frames are rejected. Late viewers receive the cached image and contribution map.

The host capability token stays in the creating tab's session storage and is not included in URLs or invitations. The server verifies it for every connection. Reloading that tab or navigating between `/r/ROOM_CODE` and `/join/ROOM_CODE` on the same site preserves its host access. The contributor page shows **Open host controls** only after the server recognizes that host; other participants see **Watch the full studio**. A studio URL alone provides viewing and contributing access, so keep the original host tab for the demo.

## Tests

```sh
node --test test/*.test.js
```

The automated suite covers deterministic tile assembly, sphere and box material bounds, box intersections, terrain hits and analytic normals, procedural sky effects, binary framing, bounded batch scheduling and reassignments, selected-worker scheduling, compatible benchmark eligibility, disconnects/timeouts, owner authorization, stale/duplicate results, cancelled runs, late-viewer replay, real HTTP/WebSocket rendering, JSONL events, database recovery, and Gemini response handling. Service adapter unit tests use simulated responses; the live-service verifier is a separate check.

For a larger coordination check, run `node test/load.mjs`. It starts an isolated loopback server, connects 32 simulated workers and a host, checks complete tile delivery, drops eight workers with unfinished batches, and checks the 100-session cap. Workers submit synthetic pixel payloads; this checks scheduling, fan-out, and recovery, not rendering correctness or phone/GPU speed. It does not use cloud credentials or the running public demo.

Optional browser tests require Playwright and Chromium:

```sh
npm install --no-save playwright
npx playwright install chromium
# Start the app in another terminal first.
node test/browser.mjs
node test/webgpu.mjs
node test/demo.mjs
node test/controls.mjs
node test/batching.mjs
node test/network-batching.mjs
```

`BASE_URL` overrides the default `http://localhost:3210`. If Playwright is provided by your environment, `PLAYWRIGHT_MODULE` can be the absolute path to its `index.mjs`. Screenshots, rendered PNGs, and reports are saved under `artifacts/` (gitignored).

The ordinary browser test covers real Worker rendering in two contexts, solo/multi-run comparison, PNG download, disconnect recovery, late-viewer canvas equality, and mobile layout. It reports GPU availability without pretending a fallback is a GPU.

The dedicated WebGPU test **requires** a GPU backend, validates shader execution, and compares the resulting image with the CPU reference. For headless Chromium on this Mac, explicit backend flags were needed:

```sh
GPU_ARGS='["--enable-unsafe-webgpu","--use-angle=metal"]' node test/webgpu.mjs
GPU_ARGS='["--enable-unsafe-webgpu","--use-angle=metal"]' node test/demo.mjs
```

`test/demo.mjs` drives the real UI with a separate host and three WebGPU worker contexts. It checks the automatic solo/crowd comparison, benchmark export, a disconnected worker's tile recovery, a finished image, and the presentation/mobile layouts. All three workers share the test computer's GPU. This verifies the workflow and shader execution, not performance across three physical phones.

`test/controls.mjs` checks that losing the solo worker cancels the comparison, the presentation Stop button remains usable when all workers pause, and the HTTPS invite QR loads correctly.

`node test/host-role.mjs` starts an isolated server and verifies host controls, viewer guidance, the explicit new-studio action, browser-tab roles, and mobile layouts. It leaves host credentials scoped to the creating tab.

`node test/scenes.mjs` starts its own isolated server and renders Aurora Desert and Neon City through two actual WebGPU worker contexts. It checks both contributors, all 64 tiles, CPU/GPU pixel agreement, the new-scene status, and mobile layout. It saves rendered PNGs and `artifacts/landscapes-report.json`. Use the same `PLAYWRIGHT_MODULE` and `GPU_ARGS` settings as the other hardware tests. Set `GENERATED_SCENE` to a saved normalized Gemini scene JSON to test that scene as well; this replays the generation response and does not make an API request. Live API functionality must be checked separately.

`test/batching.mjs` checks real sequential GPU dispatch, bounded batches, pause/resume and cancellation with queued work, and image equality with single-tile rendering. `test/network-batching.mjs` uses a local WebSocket delay proxy and alternating single-tile/batched runs to measure network overhead. It defaults to `UPSTREAM_URL=http://127.0.0.1:3211` and adds 40 ms in each direction; set `UPSTREAM_URL` to your local test server. This is a controlled latency experiment on one GPU, not a physical-phone benchmark. Run GPU timing checks separately from other rendering tests.

These are test-browser flags, not instructions for audience phones. Normal visitors use their browser's supported default configuration. The test scripts can target the live HTTPS link through `BASE_URL`.

## Scope and next improvements

- A render supports up to 64 objects in total (up to 64 spheres or 48 boxes), plus a plane or procedural dune terrain, at up to 2048 × 2048 pixels and 512 samples. Terrain intersections have a bounded 120-unit range. Materials include diffuse/metallic surfaces, bounded emission, and a reflective floor; sky effects include stars and aurora. There are no mesh uploads, animations, transparent materials, or arbitrary jobs.
- It trusts the contents of accepted pixels. Lease validation prevents accidental duplicates and stale work; it does not prove computation was honest. No payments or rewards are involved.
- Participant data is limited to chosen display names and computation metrics. Room IDs are shareable, so avoid sensitive content.
- The room/client caps, bounded settings, origin checks, and payload limits suit a supervised demo. This is not a hardened public compute marketplace.
- CPU and GPU implementations have small floating-point differences. A mixed-backend render can have slight differences in noise. **Compare 1 vs crowd** selects workers matching the solo device's renderer; the result also checks that the same baseline worker contributes to both completed runs.
- The AI and database integrations need real credentials, and physical-phone/browser compatibility needs rehearsal on the actual devices.

See `HACKATHON.md` for sponsor fit, the team split, and a three-minute demo script.
