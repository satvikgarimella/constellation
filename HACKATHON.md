# Hack Western 13 handoff

## Pitch

**“Everyone in this room is carrying a computer. Scan this code, and your browser becomes part of our render farm.”**

Constellation makes distributed computing visible: viewers see an image assemble from independently calculated tiles, can trace tiles to individual contributors, and watch the system recover when a device disappears. The immediate use is a shared graphics studio and an interactive lesson in parallel computation. Larger creator render farms are a possible direction, not a demonstrated product claim.

## Three-minute live demo

- **0:00–0:30:** Explain the idea and show a recorded solo run at fixed settings. Show the scene and the real elapsed time.
- **0:30–1:05:** Invite the judges/audience via QR. Have two rehearsed devices ready in case venue networking fails. Ask participants to opt in and keep the page open.
- **1:05–1:55:** Start the identical render with contributors. Show tiles appearing and the contribution map. Pick quality settings in rehearsal that run long enough to see the work.
- **1:55–2:20:** In a second longer run, disconnect a device while it has work. Show the reassignment counter. Explain the run ID + lease check and how faster workers collect more tiles.
- **2:20–2:45:** If Gemini is live, generate a new abstract composition from a judge's short prompt. If Tiger Data is live, show the database-backed totals. Explain that all render pixels still come from participant devices.
- **2:45–3:00:** Show the final image and actual solo-versus-crowd measurement. End with the engineering insight: independent work, small messages, opt-in participation, and recovery from unreliable workers.

For the Q&A: the server coordinates; it does not render. Every worker downloads the whole tiny scene so reflections can see objects outside its tile. No promises of linear scaling or outperforming a desktop GPU.

## Sponsor fit

Based on the event brief you supplied and the [Hack Western 13 prize page](https://hack-western-13.devpost.com/). Confirm the current [rules](https://hack-western-13.devpost.com/rules) and select only integrations actually demonstrated in the submission.

| Track | What is implemented | Remaining evidence before claiming it |
|---|---|---|
| Overall / Most Adventurous | Live distributed renderer, contribution map, device failure recovery, measurements | Rehearsed physical-device demo and a clear use case; winning is not guaranteed |
| Best Use of Gemini API | Host-only prompt-to-scene request with validated structured output | Supply a key, make successful live requests, and show the generated scene being rendered |
| Best Use of Tiger Data | Batched SQL telemetry, optional hypertable, metrics queries and database totals in the UI | Connect an actual Tiger Data service and show persisted events and query results |
| Best Use of Vultr | Docker image and Caddy HTTPS deployment files | Deploy to Vultr, verify public phone joining, and identify the infrastructure used |

Merely having the integration code is not the same as demonstrating the sponsor's service. QNX and PCBWay require a different hardware component; Auth0, Solana, TinyFish, and Entire are not integrated here.

## Team split for the remaining time

Assuming you plus two teammates:

1. **Graphics/demo owner:** Test WebGPU on the actual phones and laptop. Choose scene, quality, and a reproducible solo baseline. Capture the demo and prepare a fallback recording.
2. **Infrastructure/AI owner:** Deploy with HTTPS, configure Gemini and Tiger Data, verify each service, and collect real sponsor evidence. Watch application and database logs.
3. **Product/submission owner:** Rehearse the QR flow and failure demonstration, check mobile browser behavior, write the project story, and ensure every teammate and intended track is included.

The supplied event brief lists the submission deadline as **November 22, 2026 at 9 a.m. EST**. Reserve time for the submission itself and use the current event instructions for final requirements.

## Before presenting

- Use the host tab that created the room. Reloading in that tab keeps the token; another browser does not get owner controls.
- Use HTTPS for phone GPU participation; the local HTTP link deliberately falls back to CPU.
- Verify GPU/CPU tags and choose a consistent backend group for the benchmark.
- Finish one solo baseline with exactly the same scene and settings as the crowd run.
- Check the QR on the actual network. Do not assume local Wi-Fi allows peer connections.
- Record a successful demo before the judging slot. Save the rendered PNG and benchmark numbers.
- Describe live integrations honestly. Do not submit simulated API/database test responses as proof of sponsor use.
