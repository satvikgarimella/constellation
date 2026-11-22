# Constellation: Hack Western 13 sponsor-track audit

Checked against the organizer's published pages on **November 22, 2026**. This audit uses **Hack Western 13**, the event and prize list supplied in this chat. It does not apply to Cal Hacks or claim that Constellation has already been submitted or selected by any sponsor.

## What we can honestly target

| Sponsor track | Current status | Constellation evidence and pitch |
| --- | --- | --- |
| **[MLH] Best Use of Gemini API** | **Implemented and verified on the deployed app.** Technical fit is established; entry still requires the team's valid submission. | Gemini creates scenes and applies validated camera, lighting, and material edits while preserving imported geometry. Live verification imported a STEP model, made one real Gemini edit, exercised Undo/Redo, and rendered the result with WebGPU contributors. Show the natural-language edit and the preserved model together. |
| **[MLH] Best Use of Tiger Data** | **Implemented and verified on the deployed app.** Real rendered work was written to the database and queried back through the hosted UI/API. | The saved Tiger-hosted database connection passed local verification with certificate/hostname checks and a real Timescale hypertable. A fresh hosted WebGPU render produced 64 tiles and 65,536 pixels; database-backed metrics returned the same totals and contributor, and the UI displayed TIGER DATA. Show how render telemetry explains each device's work and performance over time. |

The official prize listing names **MLH Swag Kits** for Gemini and **Stream Deck Mini** for Tiger Data. Prize eligibility and judging remain the organizers' decision. [Organizer prize listing](https://hack-western-13.devpost.com/)

### Integration evidence

- `server/gemini.js`: real Gemini API request, strict edit validation, and imported mesh metadata sent without its triangle array.
- `server/telemetry.js`: `render_events`, bounded event batches, Timescale hypertable initialization, per-worker metrics, and time buckets. Merely having this code does not establish live Tiger Data use.
- `artifacts/render-upgrades-report.json`: passed hosted STEP/Gemini/Undo/GPU/benchmark check, saved locally and excluded from Git. Its two workers shared one Mac; the report explicitly does not establish physical-device speedup.
- `artifacts/database-ui-report.json` and `artifacts/database-ui.png`: passed hosted WebGPU-to-database verification on November 22 at 04:36 AM EST. The fresh room's 64 accepted tiles / 65,536 pixels were returned by the database-backed metrics endpoint for the same contributor. The UI showed TIGER DATA; there were no browser errors. This check used one isolated browser context and does not establish physical-phone performance.
- Provider identification is based on the configured Tiger-hosted DNS suffix and verified TLS hostname/certificate, with a real Timescale hypertable confirmed locally. No Tiger Console visit is claimed for this verification. A generic PostgreSQL response or the UI label alone would not identify the hosting provider.
- `render.yaml`: current deployment is on **Render**, not Vultr.

**Tiger Data completion gate passed:** hosted `/api/config` reported `tigerData: true` and `databaseReady: true`; a fresh render produced database rows; `/api/rooms/ROOM/metrics` returned `source: "postgres"` with matching work totals. The sanitized report and screenshot above preserve the evidence. Do not claim continuous aggregates or compression: the current implementation does not configure them.

## Every other sponsor track in the supplied event list

These are **not currently supported entries** for this project. The third column identifies the concrete missing requirement, rather than implying that using AI or a browser qualifies for all AI/browser prizes. Track names and requirements were corroborated on the organizer's live prize page. [Organizer prize listing](https://hack-western-13.devpost.com/)

| Exact track name | Listed prize | Why we are not currently claiming it |
| --- | --- | --- |
| Best Health Hack by Sun Life | $100 Amazon gift card per winning team member | No demonstrated health problem, patient workflow, or health outcome. A generic renderer is not a health solution. |
| Best Use of QNX | $1,000 winning team; $250 for each of two runners-up | Requires an AI embedded system running QNX OS, an open-source QNX AI module, and an embedded-hardware demo. The browser renderer uses none of these. |
| The Canada Life Future Me Challenge | $100 Visa prepaid gift card per winning team member | Requires a solution helping Gen Z act on their financial future. Constellation does not implement that workflow. |
| Hire Your First AI Employee by TinyFish | $75 gift card and $100 TinyFish credits per winning team member, plus team engineering-lead meeting | Requires a useful browser job performed end to end using TinyFish. It also requires posting the demo on X or LinkedIn and tagging TinyFish. No TinyFish integration or qualifying public post is present. |
| Best Hardware Prototype by PCBWay | US$50 PCBWay manufacturing credit for the winning team | Requires a hardware prototype solving a problem and an explanation of the next fabricated version. Using existing phones' GPUs is software utilization, not a new hardware prototype. |
| [MLH] Best Use of Entire | Mini Portable Projector | Requires substantial use of Entire's collaboration capabilities such as Sessions, Graph, and/or Brain. Codex subagents and GitHub commits do not establish Entire use. |
| [MLH] Best Use of Solana | Unruggable Hardware Wallets | No Solana transactions, program, wallet integration, or Solana-dependent application behavior. |
| [MLH] Best Use of Vultr | Assorted Prizes | The working deployment is on Render. Prepared Vultr deployment files or an unredeemed promo are not a running Vultr integration. |
| [MLH] Best Use of Auth0 | Wireless Headphones | Host access uses the app's own room token; no Auth0 API, login, or agent authorization integration exists. |
| [MLH] Best Domain Name from GoDaddy Registry | Digital Gift Card | The app uses an `onrender.com` subdomain. No qualifying domain registration is established. |

Render, WebGPU, Node.js, and OpenCascade are part of the technical stack, but they are not additional sponsor-prize entries in the supplied Hack Western 13 list.

## Other awards we can aim for

The **First Place Overall**, **Second Place Overall**, and **Third Place Overall** awards are general judging categories, not separate technology integrations. **Organizers Choice: Most Adventurous** is another potential fit: invite the audience to discover what their devices can compute together. Treat this as our pitch, not a guarantee of eligibility or selection. [Organizer awards](https://hack-western-13.devpost.com/)

## Submission and demo actions

- **Deadline:** Sunday, November 22, 2026 at **9:00 AM EST (America/Toronto)**. Coding also ends at that time; the rules say submissions cannot be edited after the deadline.
- Add every actual team member. Members must meet the event's registration and participation rules; the stated maximum team size is four.
- Select matching sponsor tracks and team members on **both Devpost and the event's live site**. This file does not select tracks or submit anything.
- Plan a **three-minute live demo plus one minute for questions**. The rules explicitly prohibit slide decks. General judging is listed for noon–1:00 PM EST; sponsor sessions are separate and require shortlisting.
- Demonstrate measured results honestly. The repeated benchmark feature is implemented, but separate physical devices are still needed for a genuine crowd-speedup claim.

[Official rules and submission instructions](https://hack-western-13.devpost.com/rules), [official schedule](https://hack-western-13.devpost.com/details/dates).

## Safe wording for the write-up

**Gemini, ready now:** “We use the Gemini API to generate renderable scene descriptions and edit camera, lighting, and materials through validated patches. Imported model geometry stays unchanged during those edits, and Undo/Redo makes changes reversible.”

**Tiger Data, ready now:** “We use Tiger Data to persist render telemetry and query per-device contributions and time-series activity from actual distributed renders.”

Do not describe the app as a new GPU chip, native SolidWorks renderer, full Blender replacement, QNX device, verified compute marketplace, or guaranteed faster than a laptop. Its implemented core is a distributed browser renderer with opt-in WebGPU contributors and measurable, comparable workloads.
