# Hack Western 13 handoff

## Pitch

**“Everyone in this room is carrying a computer. Scan this code, and your browser becomes part of our render farm.”**

Constellation makes distributed computing visible: viewers see an image assemble from independently calculated tiles, can trace tiles to individual contributors, and watch the system recover when a device disappears. The immediate use is a shared graphics studio and an interactive lesson in parallel computation. Larger creator render farms are a possible direction, not a demonstrated product claim.

The default **Orbit** scene has 54 spheres, emissive orange/blue accents, a chrome core, and a reflective floor. The scene limit is 64 spheres. Workloads go up to **2048 × 2048 / 512 samples**, so the demo can scale from a quick connection check to a substantial real render.

## Start the phone demo

Install `cloudflared` using the [official macOS instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) (`brew install cloudflared`). Stop any standalone app using port 3210, then run:

```sh
node --env-file-if-exists=.env scripts/share.mjs
# Equivalent: npm run share
```

Open the printed **Public studio** HTTPS link on the laptop and create a room there. Keep that host tab open. Scan its QR on the participating phones and tap **Contribute compute**. The laptop can stay as a controller with its own contribution paused.

The command starts both the app and a temporary Cloudflare Quick Tunnel, updates the share link automatically, and writes its address to `data/demo-url.json`. Keep the command and laptop running; Ctrl-C stops both processes. The public URL changes on restart and has no uptime guarantee. A persistent VM deployment is the option for a stable event address. [Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

Select **Quick check** for the first image. Once at least two devices report the same renderer, select **Live demo**, choose the **Solo device**, and click **Compare 1 vs crowd**. The app runs the same scene/settings first on that one device and then on the matching crowd, including the solo device. Save the measured result using the benchmark download button. A slower crowd run is a valid result; repeat and adjust the real workload during rehearsal.

## Three-minute live demo

- **0:00–0:30:** Show Orbit and explain that the image is traced by audience devices. Keep the HTTPS host room and two rehearsed contributors ready.
- **0:30–1:05:** Invite the judges/audience via QR. Have two rehearsed devices ready in case venue networking fails. Ask participants to opt in and keep the page open.
- **1:05–1:55:** Click **Compare 1 vs crowd** at the workload chosen in rehearsal. The solo run and matching crowd run happen automatically. Show the contribution map and actual timing result. Use **Present** for a larger image.
- **1:55–2:20:** In a separate longer run, disconnect a device while it has work. Show **Recovered tiles** and the recovery message. Explain the run ID + lease check and how faster workers collect more tiles.
- **2:20–2:45:** If Gemini is live, generate a new abstract composition from a judge's short prompt. If Tiger Data is live, show the database-backed totals. Explain that all render pixels still come from participant devices.
- **2:45–3:00:** Show the final image and actual solo-versus-crowd measurement. End with the engineering insight: independent work, small messages, opt-in participation, and recovery from unreliable workers.

For the Q&A: the server coordinates; it does not render. Every worker downloads the whole tiny scene so reflections can see objects outside its tile. No promises of linear scaling or outperforming a desktop GPU.

## Sponsor fit

Based on the event brief you supplied and the [Hack Western 13 prize page](https://hack-western-13.devpost.com/). Confirm the current [rules](https://hack-western-13.devpost.com/rules) and select only integrations actually demonstrated in the submission.

| Track | What is implemented | Remaining evidence before claiming it |
|---|---|---|
| Overall / Most Adventurous | Orbit renderer, public HTTPS demo flow, automatic solo/crowd comparison, contribution map, device failure recovery | Rehearsed physical-device demo and a clear use case; winning is not guaranteed |
| Best Use of Gemini API | Host-only prompt-to-scene request with validated structured output | Supply a key, make successful live requests, and show the generated scene being rendered |
| Best Use of Tiger Data | Batched SQL telemetry, optional hypertable, metrics queries and database totals in the UI | Connect an actual Tiger Data service and show persisted events and query results |
| Best Use of Vultr | Docker image and Caddy HTTPS deployment files | Deploy to Vultr, verify public phone joining, and identify the infrastructure used |

The temporary Cloudflare tunnel does not demonstrate Vultr usage. Merely having integration code is not the same as demonstrating a sponsor's service. QNX and PCBWay require a different hardware component; Auth0, Solana, TinyFish, and Entire are not integrated here.

## Team split for the remaining time

Assuming you plus two teammates:

1. **Graphics/demo owner:** Test WebGPU on the actual phones and laptop. Rehearse **Compare 1 vs crowd** and choose a workload that produces meaningful timing. Capture the demo and prepare a fallback recording.
2. **Infrastructure/AI owner:** Keep the HTTPS share process running or deploy a stable VM, configure Gemini and Tiger Data, verify each service, and collect real sponsor evidence. Watch application and database logs.
3. **Product/submission owner:** Rehearse the QR flow and failure demonstration, check mobile browser behavior, write the project story, and ensure every teammate and intended track is included.

The supplied event brief lists the submission deadline as **November 22, 2026 at 9 a.m. EST**. Reserve time for the submission itself and use the current event instructions for final requirements.

## Before presenting

- Use the HTTPS host tab that created the room. Reloading in that tab keeps the token; a different browser or origin does not get owner controls.
- Keep the laptop and share process running. Confirm the public HTTPS link still loads before showing its QR; a saved tunnel URL can expire.
- Verify each phone's **WEBGPU** or **CPU WORKER** tag. HTTPS makes GPU access possible on supported devices, but it does not guarantee an adapter.
- Use **Compare 1 vs crowd** for matching scene/settings/backend measurements. Keep the solo device participating in both runs. Repeat runs to account for network variation and warming devices.
- Check each physical phone on the actual network. Automated tests cover three GPU browser contexts on one computer, not three physical phones or guaranteed crowd scaling. The separate WebGPU test compares the new scene's output against its CPU reference; the 22 automated tests cover the scheduler and supporting logic.
- Record a successful demo before the judging slot. Save the rendered PNG and downloadable JSON benchmark report. Confirm every intended contributor actually completed tiles.
- Describe live integrations honestly. Do not submit simulated API/database test responses as proof of sponsor use.
