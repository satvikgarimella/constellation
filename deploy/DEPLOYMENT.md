# Constellation on Vultr

This is a deployment procedure, not evidence that a Vultr server has been created or tested. The app runs one Node coordinator and a Caddy HTTPS proxy. Participating browsers do the rendering, so the server does not need a GPU.

## Proposed server and cost

The minimum proposed demo server is **Regular Cloud Compute `vc2-1c-1gb` in Toronto (`yto`)**: 1 vCPU, 1 GiB RAM, 25 GB SSD, and 1 TB transfer. The official public API returned **US$5/month and US$0.007/hour** on November 21, 2026. Toronto is in the plan's supported location list. This describes plan support, not a reservation or a guarantee of immediately available capacity. [Official plans API](https://api.vultr.com/v2/plans?per_page=500), [official regions API](https://api.vultr.com/v2/regions).

For more memory headroom, `vc2-1c-2gb` has 1 vCPU, 2 GiB RAM, 55 GB SSD and 2 TB transfer, listed at **US$10/month and US$0.014/hour** in the same API. Prices exclude taxes, domains, backups, overages and other optional resources. Confirm the final order total and approved spending limit before creating anything. Reuse an existing suitable server if available.

These are engineering starting points, not load-tested capacity claims. Start with a single supervised room at modest resolution. Rooms, leases and cached images live in process memory; a server restart ends active rooms. A maximum-size 2048 × 2048 RGBA image alone occupies about 16 MiB before other state and copies. Do not scale the app to multiple replicas: room state is not shared between instances.

## Required inputs

- An approved existing Vultr instance, or approval to create the exact plan above within a stated budget.
- Server address, SSH username and an authorized local SSH key. Do not paste private keys into chat or commit them.
- A public hostname you control, such as `render.example.com`, with DNS access.
- An approved source commit from this repository to deploy.
- Server-only Gemini and Tiger Data values in `.env` if those integrations are part of the demonstration. Rendering works without them; that does not demonstrate sponsor integration.

Use a supported Ubuntu image with Docker Engine and the Compose plugin. Vultr offers a [Docker Marketplace image](https://docs.vultr.com/how-to-use-vultrs-docker-marketplace-application). On an existing Ubuntu host without Docker, follow the [official Docker installation guide](https://docs.docker.com/engine/install/ubuntu/); verify both `docker version` and `docker compose version` before continuing. This guide does not install packages on the current computer.

## DNS and network

Point the hostname's A record at the server's public IPv4 address. Add an AAAA record only if IPv6 routing and firewall rules are also correct. The value of `DOMAIN` is a bare hostname, without `https://`, a path, or a trailing slash.

Permit TCP 80 and TCP 443 in the Vultr firewall and host networking. Permit SSH only from the operator's trusted address where practical. UDP 443 is optional for HTTP/3 and is already published by Compose. Do not publish app port 3210 or a database port. Apply the [Vultr firewall group](https://docs.vultr.com/products/compute/instances/cloud-compute/networking/enable-firewall) to the chosen instance. Docker-published ports can bypass UFW rules, so use the provider firewall as well; see [Docker's firewall limitations](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations).

Caddy obtains and renews the certificate when DNS points to this host and its challenge ports are reachable. Its certificate state is persisted in the `caddy-data` volume. A bare IP or a self-signed certificate is not an equivalent phone-friendly setup for the supplied Caddy configuration. [Caddy automatic HTTPS prerequisites](https://caddyserver.com/docs/automatic-https).

## Deploy the reviewed source

The following commands run **on the authorized server**, in a new checkout. Replace `REVIEWED_COMMIT_SHA` with the exact tested commit; it is intentionally not a moving branch name. If the repository is private, configure Git access using the normal account/key flow without embedding a token in its URL.

```sh
git clone https://github.com/satvikgarimella/constellation.git constellation-render
cd constellation-render
git checkout --detach REVIEWED_COMMIT_SHA
cp .env.example .env
chmod 600 .env
```

Edit `.env` with the server's editor. Set `DOMAIN=render.example.com` to the real hostname. Enter `GEMINI_API_KEY`, the selected `GEMINI_MODEL`, and `DATABASE_URL` locally if needed. Preserve required TLS options in the database connection string. Never place these values in `public/`, terminal screenshots, shell command arguments, or Git. Compose sets `PUBLIC_URL=https://${DOMAIN}`, binds the coordinator internally, and uses a persistent volume for telemetry.

From the repository root, validate without printing the interpolated configuration, then build and start:

```sh
docker compose --env-file .env -f deploy/compose.yaml config --quiet
docker compose --env-file .env -f deploy/compose.yaml up --build -d
docker compose --env-file .env -f deploy/compose.yaml ps
```

The `app` service should become healthy and Caddy should run. If startup fails, inspect logs locally, taking care not to share database connection strings or API credentials that an upstream error may contain:

```sh
docker compose --env-file .env -f deploy/compose.yaml logs --tail 80 app caddy
```

## Verify from another computer

Run the probe from the matching local checkout with dependencies installed and Node 22.9 or newer. Replace the example hostname with the deployed origin:

```sh
BASE_URL=https://render.example.com MATCH_LOCAL_ASSETS=1 node scripts/verify-deployment.mjs
```

The script checks TLS/HTTPS reachability, health, public configuration, the application and renderer assets, room creation, the join page, QR output, and simultaneous host/guest WebSocket connections. `MATCH_LOCAL_ASSETS=1` compares the served browser assets with this checkout, catching an old frontend deployment. The app currently has no server build identifier, so this does not attest the backend commit. The report is written to the ignored `artifacts/deployment-verification.json` and does not contain host tokens or service credentials.

The probe creates one empty room and closes its two sockets. That room expires later; repeated probes can hit the room-creation rate limit. It does not start a render or invoke Gemini. For a local-only check, `BASE_URL=http://127.0.0.1:3210` is also accepted. Remote HTTP is rejected.

To require configured integrations as an additional deployment gate:

```sh
BASE_URL=https://render.example.com MATCH_LOCAL_ASSETS=1 REQUIRE_GEMINI=1 REQUIRE_TIGER_DATA=1 node scripts/verify-deployment.mjs
```

Those flags only check reported configuration/database readiness. Verify a real Gemini scene response and an actual Tiger Data telemetry write separately. Finally, open the deployed site on two physical phones, join the same room, keep both pages visible, and complete a render. Confirm both devices contribute tiles, then disconnect a device during another render and verify remaining work finishes. Passing a socket probe alone does not establish that mobile WebGPU works.

## Update, rollback, and stop

Before updating, record `git rev-parse HEAD` as the rollback commit, save any telemetry that must be retained, and finish active demos. Fetch and check out the next reviewed commit only in a clean server checkout, then run the same Compose build/start and verification commands. The checkout must include all intended uncommitted local work before it is committed and deployed.

To roll back, check out the recorded commit in that clean checkout and repeat `up --build -d`. This restarts the coordinator and ends active rooms. Persistent telemetry and Caddy volumes remain. Avoid `down -v`, `docker volume prune`, or overwriting `.env` during rollback.

To stop the containers while keeping volumes:

```sh
docker compose --env-file .env -f deploy/compose.yaml stop
```

Stopping the app is not a cloud spending limit. Manage or remove the Vultr resource through an explicitly authorized account action when the demo is over; export required data before deleting any instance.
