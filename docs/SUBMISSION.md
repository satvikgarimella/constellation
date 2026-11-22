# Constellation — submission draft

**Prepared for Hack Western 13. This file is a draft; it has not been submitted.** Replace the bracketed fields and confirm every selected track before posting. Do not copy these preparation notes into the public story.

## Submission details

| Field | Draft value |
| --- | --- |
| Project name | Constellation |
| Tagline | A shared render studio powered by the browsers in your room. |
| Live demo | https://constellation-render.onrender.com/ |
| Source code | https://github.com/satvikgarimella/constellation |
| Team | [Add every actual team member and their correct Devpost profile] |
| Demo recording | [Add an actual recording URL only after recording and reviewing it] |
| Sponsor tracks | **[MLH] Best Use of Gemini API** and **[MLH] Best Use of Tiger Data**. Both integrations are verified on the hosted app; select the tracks during submission. See [SPONSORS.md](SPONSORS.md). |

## Inspiration

We wanted to explore a simple question: can the devices already in a room help create something together? A design team may have a laptop and several phones available, but a render often runs on one device. We built Constellation to make shared browser computation visible, useful, and measurable.

Instead of assuming that more participants must mean more speed, we made the comparison part of the product. A group can see the image assemble, inspect who contributed, and measure whether sharing this particular workload helped.

## What it does

Constellation is a browser-based render studio. A host imports a supported 3D model or chooses a procedural scene, invites contributors with a QR code, and starts a render. Participants explicitly opt in; supported devices compute image tiles with WebGPU and return their pixels to the studio.

The Gemini API supports natural-language scene creation and reversible edits. A request such as “keep this model's shape, make the material red, and use sunset lighting” changes validated appearance settings while preserving imported geometry. Undo and Redo restore accepted scene versions.

The studio accepts bounded STL, triangulated OBJ, and STEP imports. STEP surfaces are converted to triangles inside a disposable browser worker. During rendering, unfinished work is reassigned if a contributor leaves. A repeated benchmark compares a selected device alone with larger groups containing that device, using the same scene and render settings. It reports median times, variability, individual trials, and speedup—including results below 1×.

## How we built it

The interface uses JavaScript, HTML, and CSS. A Node.js coordinator communicates with browsers over WebSockets, assigns leased batches of tiles, tracks accepted results, and relays image data. The host canvas assembles the image. A WGSL compute shader performs path tracing through WebGPU; a CPU reference renderer provides compatibility and a way to check shader output.

Imported triangle meshes use a bounding-volume hierarchy to avoid testing every triangle for every ray. Geometry is cached during a render rather than repeatedly sent with every job. The open-source `occt-import-js` WebAssembly package provides STEP conversion; its notices are retained in the project.

Gemini returns structured data. The server validates complete scenes and restricts edits to supported camera, lighting, and material changes. It preserves mesh vertices in the accepted scene instead of asking the model to regenerate them. The app is deployed on Render with HTTPS and WebSocket support. Tiger Data persists the actual render-event stream in PostgreSQL/TimescaleDB and serves per-device and time-series SQL queries. The studio displays database-backed contribution totals alongside its live render state.

**Development:** Codex assisted implementation and testing; the source identifies the application code and third-party components.

**Built with:** JavaScript, Node.js, WebGPU, WGSL, Web Workers, WebSockets, Canvas, Google Gemini API, Tiger Data, PostgreSQL, TimescaleDB, OpenCascade / occt-import-js, Render.

## Challenges we ran into

The difficult part was making independent browsers produce a coherent image and a defensible comparison. Devices work at different speeds, can pause in the background, and may disconnect while holding jobs. We introduced leased work, bounded batches, stale-result checks, and explicit cancellation when benchmark conditions change.

We also had to separate AI creativity from geometry integrity. Asking a language model to recreate an imported model would make changes unpredictable. Validated appearance patches preserve the actual mesh and make Undo useful.

Model import added another layer: file validation, triangulation limits, GPU data layout, and matching CPU/GPU intersections. Keeping geometry cached made larger models practical within the prototype's limits.

## Accomplishments we're proud of

- A deployed workflow that connects model upload, a real Gemini edit, Undo/Redo, and actual GPU rendering.
- Real triangle rendering for imported models, including STEP conversion in the browser. A public curved STEP assembly and original STL/OBJ fixtures also passed GPU-versus-CPU image checks.
- Repeated, exportable benchmarks with warmups, fixed participant groups, and identical scene/settings checks.
- Recovery of unfinished work when participants leave during ordinary renders.
- Hosted Tiger Data telemetry verified by rendering 64 GPU tiles and reading back all 64 tiles and 65,536 pixels for the same contributor through the database metrics endpoint.
- Automated tests and browser checks for scene integrity, permissions, malformed inputs, job recovery, and GPU pixels against a CPU reference.

The hosted acceptance check completed a real STEP import, one Gemini appearance edit, Undo/Redo, and a distributed render through two hardware WebGPU browser workers. Those workers shared one Mac. That establishes the workflow and shader execution; it does **not** establish speedup across separate physical devices.

**Optional physical-device result—include only after a completed test:**

> On [date], [laptop model] rendered [scene] at [resolution / samples / bounces] in a median [solo time] seconds. The same laptop plus [other physical devices] took [group time] seconds, or [ratio]× solo throughput. Each group had one warmup and three measured trials; timings included networking and scheduling. [Link to the actual report or recording.]

If that test is incomplete or slower, report that directly. Do not substitute the same-Mac browser test for this paragraph.

## What we learned

Distributed rendering is as much about coordination and measurement as raw compute. Additional workers help only when their useful work outweighs scheduling and transfer overhead. Reporting the participant set, quality, timing variation, and renderer type makes a result more useful than a single speedup number.

We also learned that a constrained AI editing interface can preserve a user's work while still offering creative control. The model proposes an edit; validation and version history keep the scene manageable.

## What's next

We want to evaluate more physical-device combinations and representative design models, then optimize the bottlenecks those measurements reveal. Future work includes broader material support, textures, larger meshes, and stronger result verification for untrusted contributors. The present importer remains bounded to 10 MB and 10,000 triangles, with one material and no animation. Native SolidWorks files require exporting to a supported format.

## Final submission checklist

- [ ] Replace every bracketed field and remove preparation notes from the submitted text.
- [ ] Add every actual team member; confirm participation eligibility and the four-person maximum.
- [ ] Select only supported tracks, and ensure team membership and track choices match on Devpost and the organizer's live site. Get the live-site link from the organizers; do not guess its hostname.
- [ ] Confirm live URL and repository visibility, credits/licenses, and that no secrets appear in screenshots or the repository.
- [ ] Rehearse the three-minute **live** demo and one-minute Q&A; no slide deck. Follow [DEMO.md](DEMO.md).
- [ ] Keep performance claims tied to their actual report and physical hardware. State limitations plainly.
- [ ] Submit before **9:00 AM EST, November 22, 2026**, and confirm the submission status. The rules say coding ends then and submissions cannot be edited after the deadline.

Sources: [official event](https://hack-western-13.devpost.com/), [official rules](https://hack-western-13.devpost.com/rules), [official schedule](https://hack-western-13.devpost.com/details/dates). Sponsor status is maintained separately in [SPONSORS.md](SPONSORS.md).
