---
name: rpc-artifact-ops
description: Rip Packs City Cowork artifact operations — load when building, updating, refreshing, or retiring a live RPC dashboard artifact (the self-contained HTML views that re-query Supabase on open). Triggers on "build an artifact", "new dashboard", "update the artifact", "refresh the artifact", "retire an artifact", "make a live view", or touching any rpc-* Cowork artifact. Encodes the brand stack, the callMcpTool data pattern, the allowed libraries, and the durable-vs-ephemeral discipline.
---

# RPC Cowork artifact operations

Cowork artifacts are self-contained HTML dashboards that re-query the live DB through `window.cowork.callMcpTool` every time they open. RPC keeps a standing estate of them (ops health, FMV, wallets, offers, traction, rewards, insights, pack/serial boards). Build/update with `create_artifact` / `update_artifact`; retire by tombstone. Pair with `rpc-data` (correct SQL) and, when the artifact backs a public page, `rpc-insights-qa`.

## Brand stack (match the estate — it is ALL dark)

A new artifact that ships on the default light base renders inconsistently and reads as off-brand (the 2026-06-20 drift, where two one-off artifacts shipped light while the other 14 were dark). Match this:

- **Dark theme:** near-black bg (`#0c0c0e`), light text. Author dark from the start (most older artifacts layer a dark override block over a light base — don't inherit that complexity).
- **Accent = RPC red `#E03A2F`** on KPI values, the `h1` underline, section-header rules, and the Reload button. Hardcoding the hex INSIDE an artifact is fine — the no-hardcode-literals rule is for the app repo, not artifacts — but never introduce a second accent color.
- **Display headings** (`h1`/`h2`/`th`): UPPERCASE + letter-spacing. Artifacts can't load Google Fonts (sandbox), so this is the accepted Barlow-Condensed approximation — never ship default serif / Title-Case headings.
- **Numbers, wallets, pills:** system monospace (the Share Tech Mono approximation).
- **House pattern:** an `<h1>` with a red underline. The view header already provides a Reload button — don't build a second one.

## Data pattern (runtime)

- Call tools on page load — reads are transparently cached and the header Reload re-runs them.
- Unwrap every result: `const r = await window.cowork.callMcpTool(name, args); const payload = r.structuredContent ?? JSON.parse(r.content[0].text);`. Reuse the estate's `extractRows(payload)` helper (handles the Supabase `execute_sql` `[{...}]` shape and the untrusted-data wrapper).
- **Probe the tool once in chat first** to confirm the real response shape before wiring it — MCP wrappers rename params and reshape output vs the raw API.
- Dominant tool is Supabase `execute_sql` (project `bxcqstmqfzmuolpuynti`); Vercel `list_deployments` for deploy/cost views. List ONLY the tools you actually call in `mcp_tools`.
- Heavy aggregate queries (e.g. the wmc ~1.58M-row scans) need a busy-skip guard or a bounded/precomputed source — see `rpc-data` for which scans are expensive and for the canonical-edition / latest-FMV patterns.

## Libraries + storage

- Only Chart.js, Grid.js, and Mermaid may be CDN-loaded — use the exact tags `update_artifact` documents (incl. `integrity` + `crossorigin`). Everything else must be inline. No browser storage APIs except `localStorage`, which persists across reloads/restarts — use it to remember the user's filter/sort choices.

## Durable vs ephemeral (the discipline)

- Build DURABLE dashboards that re-query live data and stay useful. Do NOT bake point-in-time numbers into headings/KPIs that will rot, and do NOT hardcode counts/dates in prose that the live query already returns (frozen "143 wallets"-style labels are the common drift).
- A one-off investigation snapshot (baked rows, a "snapshot · <date>" framing, a mission that closes) is EPHEMERAL — fine to make, but RETIRE it once the mission closes (`pack-drops-ev-check` / `rpc-ts-data-mission` were retired 2026-06-22 once their missions shipped).
- `rpc-daytime-monitor` validates the estate nightly via backing-object row-probes (it can't reach the OneDrive HTML in a scheduled run), so point each artifact at a stable view/table/RPC that returns rows, and keep its data source aligned with a real DB object.

## Update / retire

- Update: `list_artifacts` → Read the returned `path` → write the FULL updated HTML to a scratch file → `update_artifact(id, html_path, update_summary)`. There is NO partial edit — reproduce the whole document (or Edit the on-disk index.html in place, then point `html_path` at it).
- Retire: there is no delete tool — `update_artifact` the body to a small on-brand "Retired — superseded by <x> / mission closed <date>" tombstone (reversible; matches the house RETIRED-tombstone pattern).
- Artifacts live OUTSIDE the git repo (OneDrive), so they are never part of a Claude Code handoff — all artifact work happens in Cowork.
