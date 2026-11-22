# Constellation demo runbook

**Live app:** https://constellation-render.onrender.com/  
**Source:** https://github.com/satvikgarimella/constellation

Hack Western 13 calls for a **three-minute live demo and one minute of questions, with no slide deck**. The published coding/submission deadline is **Sunday, November 22, 2026, at 9:00 AM EST (Toronto)**. [Official rules](https://hack-western-13.devpost.com/rules), [schedule](https://hack-western-13.devpost.com/details/dates).

## The point of the demo

“Constellation lets a small team upload a model, direct its appearance with language, and pool available browsers to render it. It measures whether sharing the work actually helped.”

Show three things: the imported geometry survives an AI edit; contributing browsers calculate real pixels; the benchmark reports identical-work timings, including slower results. Physical-device speedup is a result to measure, not an assumption.

## Set up before the judging timer starts

1. Open the live app a few minutes early so the free service is awake. Create a fresh room. Confirm the laptop tab says **Host** and **Live connection**. Keep this original tab open; a room URL alone does not give another tab host controls.
2. Use **Your 3D model → Choose File** for a rehearsed STL, triangulated OBJ, or STEP file. Use **Try a sample chair** if a real model is unavailable. Tell judges when you are using the supplied sample. Keep the file on the laptop for a fresh-room recovery.
3. Name the laptop **Host laptop**, click **Contribute compute**, and confirm **WEBGPU**. Open **Invite devices**. On each separate phone/laptop, scan the QR, enter a distinct name, tap **Contribute compute**, and keep the page visible. Use only matching backends for the comparison.
4. Select **Quick check → Start render**. Confirm 100%, actual tiles attributed to every intended contributor, and a recognizable image. Toggle **Contribution map** to show ownership.
5. After the quick render, confirm the activity panel shows **TIGER DATA** and its database-query tile total increases with accepted work. These are cumulative room totals, so later renders add to them. This is the sponsor evidence: actual render events queried from the database.
6. Rehearse the edit below. **Edit current scene** changes appearance/framing; **Generate new scene** replaces the composition. After an edit, click **Start render** to see new pixels. **Undo / Redo** changes the scene; render again to show the restored version. History lives in this tab and resets on refresh.
7. Run and export the physical-device benchmark below before judging. Leave a completed graph available. A full repeated benchmark can outlast a short pitch; use its clearly labeled rehearsal report if necessary. Do not present an earlier scene's numbers as a measurement of a newly edited scene.
8. Rehearse an ordinary render long enough to disconnect a contributor while it is marked **Rendering**. Disconnect recovery is a separate demo: interrupting a repeated benchmark correctly cancels that benchmark.

Suggested edit:

> Keep this model's geometry and camera unchanged. Make the material red and change the lighting to a warm sunset.

## Three-minute live demo

| Time | Operator action | Speaker script |
| --- | --- | --- |
| 0:00–0:20 | Show the studio and prepared model. | “A small team can have several capable devices in the room, but usually renders on one of them. Constellation turns opt-in browsers into a shared render farm and measures whether pooling them helps.” |
| 0:20–0:45 | Import the rehearsed file, or point to the sample already imported. | “This is a real triangle model. We accept STL, triangulated OBJ, and bounded STEP imports. STEP conversion happens in a browser worker; the renderer receives the converted geometry.” |
| 0:45–1:10 | Enter the suggested prompt, click **Edit current scene**, then briefly **Undo → Redo**. | “Gemini changes lighting, materials, or the camera through a validated patch. The mesh geometry stays unchanged. The edit is reversible. Gemini directs the scene; the contributing devices calculate the image.” |
| 1:10–1:40 | Show QR/device list; with already joined devices, choose **Quick check → Start render** and enable **Contribution map**. | “Each contributor traces different image tiles with WebGPU. The server assigns jobs and relays the pixels. Faster workers naturally collect more jobs. These colored regions show which browser completed each part. Tiger Data stores render events and lets us query each device’s contribution.” |
| 1:40–2:15 | Show the completed physical-device graph/report; optionally start a new test if rehearsal proves it fits. | “We compare the same scene and quality with the selected laptop alone and then larger groups that include it. Each group warms up once and gets three measured runs. Bars show medians; whiskers show the range. These numbers include networking and scheduling.” Add the result sentence below only after filling it from an actual physical-device report. |
| 2:15–2:45 | Start the rehearsed longer **ordinary** render. Close one active contributor's tab. Point to **Recovered tiles** and remaining contributors. | “A volunteer can leave at any time. Its unfinished work returns to the queue, and the remaining devices continue. This recovery run is separate from the benchmark so the timing comparison stays valid.” |
| 2:45–3:00 | Show the image and download button. | “Our prototype combines reversible AI scene direction, actual distributed GPU rendering, and measurements you can inspect. The next question is which real workloads and device combinations benefit most.” |

If a render is still running at the end, leave it visible during questions. Do not promise that it will finish within a specific time unless rehearsal established that on these devices.

Physical-result sentence to fill from the export:

> “On **[DATE/TIME]**, this **[LAPTOP MODEL]** took a median **[SOLO SECONDS]** seconds. The same laptop plus **[NUMBER AND MODELS OF OTHER PHYSICAL DEVICES]** took **[CROWD SECONDS]** seconds at **[RESOLUTION, SAMPLES, BOUNCES]**: **[RATIO]×** the solo throughput.”

If the ratio is below 1×, say that the crowd was slower for this workload. If no physical test has finished, say: **“The full benchmark workflow has passed in isolated browser sessions on one Mac. We have not established separate-device speedup yet.”**

## Ninety-second rehearsal version

Pre-connect participants and have a completed, correctly labeled report ready. This is a shorter practice script, not a replacement for the event's three-minute allocation.

- **0:00–0:15:** “Constellation lets a team pool available browsers to render a 3D model and measure the result.” Show the imported model and actual contributor list.
- **0:15–0:35:** Ask for red material and sunset lighting; click **Edit current scene**. Demonstrate **Undo / Redo**. “The AI edits appearance while preserving geometry.”
- **0:35–1:00:** Start a rehearsed quick render and enable **Contribution map**. “Every colored region is work completed by a contributor. The cloud server schedules; the devices render.”
- **1:00–1:20:** Show the earlier report with its scene/settings label. State when and on what hardware it was recorded. Explain medians and range; use only the measured result.
- **1:20–1:30:** “We also recover unfinished tiles when a device leaves.” Demonstrate recovery only if the rehearsed workload fits; otherwise offer the live recovery test during questions.

## Run the physical-device benchmark

Use the laptop as both host and contributor, plus two or more **separate physical** devices. Multiple tabs or isolated browser contexts on one computer do not establish crowd scaling.

1. Record the device table below. Keep the pages visible, use stable connections, and avoid other heavy tasks during the test. Name devices so the UI and report can be matched to the hardware.
2. Choose **Solo device → Host laptop**. Confirm all intended participants use **WEBGPU**. CPU contributors can render, but they do not join this GPU comparison.
3. Keep the scene fixed. Begin with **512 × 512 / 32 samples**; if timings are too short to be informative, use **Live demo** (1024 × 1024 / 128 samples). Report every workload tried rather than retaining only a favorable result.
4. Click **Run scaling benchmark**. It uses nested groups of 1, 2, 4, and the full selected group, with duplicates omitted and a maximum of eight matching contributors. One warmup and three rotated-order measured trials run per group. Do not change scenes, pause devices, or switch their pages into the background.
5. Wait for **Complete**, then click **Export results**. Check three measured trials per group, the correct scene/settings label, the laptop in each group, no retries, and real tile work from each selected device.
6. Save the JSON with the device table and a screenshot. If it stops, retain the incomplete report and its reason; reconnect before starting a fresh test.

| UI device name | Physical make/model | Browser/version | Displayed backend | Wi-Fi or cellular | Same physical device as any other row? |
| --- | --- | --- | --- | --- | --- |
| Host laptop | [fill] | [fill] | [fill] | [fill] | No |
| [contributor 1] | [fill] | [fill] | [fill] | [fill] | No |
| [contributor 2] | [fill] | [fill] | [fill] | [fill] | No |

Record: **Toronto date/time [fill] · room [fill] · model/source [fill] · resolution/samples/bounces [fill] · report filename [fill]**.

## One-minute Q&A and recovery notes

| Question or problem | Accurate answer or action |
| --- | --- |
| “Is the AI generating the final image?” | Gemini generates a structured scene or appearance edit. The browser ray tracer computes the final pixels. |
| “What does Tiger Data do?” | It persists render telemetry and serves per-device totals and time-series queries. Point to **TIGER DATA** and the database-query totals. The repeated benchmark graph is calculated from completed run records; do not claim database continuous aggregates or compression. |
| “Does adding phones always make it faster?” | No. The benchmark exposes the tradeoff between additional compute, network overhead, device differences, and workload size. Use the actual recorded result. |
| “Is this a GPU you built?” | We built the renderer, scheduler, scene workflow, and measurements. We use the GPUs already in participating devices. |
| “Does it open every CAD file?” | No. This prototype supports bounded STEP/STL/triangulated OBJ imports: 10 MB, 10,000 triangles, one material, no textures/animation, and Y-up framing. Native SolidWorks files need exporting to a supported format. |
| “What happens to the model?” | Geometry is shared with room contributors to calculate their tiles. Gemini edit requests receive mesh metadata and material settings, not the triangle array. |
| “Can strangers cheat the computation?” | The prototype trusts pixel results from participants. It validates job ownership and payloads, but it does not independently verify every submitted pixel or implement paid compute credits. |
| Controls are disabled | Confirm **Host**, a live connection, and no render/edit in progress. Starting a render also requires at least one opted-in contributor. Return to the original host tab if necessary. |
| Gemini is unavailable | Keep the accepted model/scene and render it. Show a previously saved AI example as recorded evidence, clearly labeled. Do not call a preset an AI result. |
| Only one physical device is available | Render on that device and demonstrate import, AI editing, and Undo. Show the benchmark controls, but do not create extra tabs and call them separate phones. |
| A model is rejected | Read the error, try the supplied sample chair, and state the supported limits. An unsupported model is not a successful import. |
| Hosted room expired | Open the root URL, create a new room, import the local file again, and invite participants using the new QR. |

Sponsor claims should follow [SPONSORS.md](SPONSORS.md). **Gemini and Tiger Data are both verified on the hosted app.** The database acceptance check rendered 64 real GPU tiles (65,536 pixels), then queried matching totals for the same contributor from the configured database, with no browser errors. This database check used one Mac and makes no physical-crowd performance claim.

Additional importer evidence is in [MODEL_VALIDATION.md](MODEL_VALIDATION.md): a public curved STEP assembly, a generated STL gear, and a generated OBJ vase passed actual GPU/CPU comparisons. These are representative fixtures, not the user’s own CAD files.
