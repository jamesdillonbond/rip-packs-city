---
name: rpc-artifact-ops
description: Rip Packs City artifact operations — load when building, updating, refreshing, or retiring a live RPC dashboard artifact (the self-contained HTML views on claude.ai that re-query Supabase on open). Triggers on "build an artifact", "new dashboard", "update the artifact", "refresh the artifact", "retire an artifact", "make a live view", or touching any rpc-* dashboard. Encodes where the estate lives, the mcp-capability data pattern, the throwing helper, the brand stack, and the durable-vs-ephemeral discipline.
---

# RPC dashboard artifact operations

RPC keeps a standing estate of live dashboards (ops health, QA scorecard, deploys + cost, wallet, traction, rewards, pack/serial/squeeze boards). Each is a self-contained HTML page that re-queries the live DB every time it opens. Pair with `rpc-data` (correct SQL) and, when a dashboard backs a public page, `rpc-insights-qa`.

## Where the estate lives (changed 2026-10-20, #114)

- **The live estate is claude.ai artifacts**, published with the `Artifact` tool. The 11 legacy desktop Cowork dashboards were ported on 2026-10-20; the old desktop copies still exist in the desktop sidebar but are superseded and still carry the old non-throwing helper. **The URL map is in `docs/reference/known-issues.md` #114.**
- **Source of truth is the repo:** `docs/cowork-skills/<name>.html`, one file per dashboard, flat in that folder so `__tests__/artifact-helpers-do-not-render-failure-as-empty.test.ts` covers every one. Publish FROM a copy of that file and commit the same bytes (`cmp` them) in the same turn.
- **Find an artifact:** `Artifact` `action:"list"`. **Read the live one:** `action:"read"` with its `url` (builds on the stored version; a publish to a URL this conversation has not read is refused). **Update:** publish with that `url` (or the same `file_path` within one session). **Legacy desktop dashboards:** `mcp__remote-devices__list_legacy_live_artifacts` lists them and `device_stage_files` with `artifact_ids` stages their HTML — only when the session is linked to Trevor's computer, and migrate only with Trevor's yes.

## Data pattern (runtime)

- Declare `capabilities: {mcp: {servers: [{server: "Supabase", tools: ["execute_sql"]}]}}` (add `{server: "Vercel", tools: ["list_deployments"]}` only on a page that reads deploys). List only tools the page calls; an empty `tools` list is refused.
- Pages written for the Cowork bridge call `window.cowork.callMcpTool(name, args)`. The ported pages keep that call and define it with the **port shim** at the top of each file (copy it from any ported page, e.g. `docs/cowork-skills/rpc-qa-scorecard.html`): it maps the call onto `claude.use("mcp").callTool(server, tool, args, {cache:false})`, retries a `retryable` read once, and **THROWS on every rejection code** with that code's fix copy (reconnect / add the connector / allow it for the page / wait), and on a resolved `{error:{…}}` payload. A brand-new page can call `claude.use("mcp")` directly, but must keep the same rule: every failure throws into the panel's `catch`.
- **Unwrap with the estate's `extractRows`** (copy it from `docs/cowork-skills/rpc-insights-health.html`; a hand-written one will reproduce the defect). The Supabase connector double-wraps its answer: `content[0].text` is a JSON envelope `{"result":"<prose> <untrusted-data-…>[rows]</…>"}`; the helper unwraps `result` then slices the array.
- 🚨 **`extractRows` MUST THROW ON A FAILED READ.** Measured 2026-09-14: a missing relation came back as `{error:{name,message}}`, which fell through to `return [raw]`; `{isError:true}` returned `[]`. Neither threw, so every panel's honest `catch` never fired and `rpc-insights-health` published "7 surface(s) have an EMPTY backing view" off a query that never ran. The helper's object branch starts with `if(raw.isError===true||(raw.error&&typeof raw.error==="object")) throw …`, and a non-empty string that parses to nothing throws `unreadable tool response`. **Only `null`, `""` or a payload that parses to `[]` may return `[]`.** Measure, do not eyeball: `node scripts/audit-cowork-artifact-failure-handling.mjs <dir of html>` must report **0 blind**.
- **A non-Supabase reader needs the same rule by hand.** 2026-10-20: the Vercel connector now answers `list_deployments` as `{result:{deployments:{pagination, deployments:[…]}}}`; the old reader looked for `.deployments` at the top and returned `[]` — "no deploys" off a successful call. Unwrap `result`, and **throw when the list is missing** rather than defaulting to `[]`.
- ⛔ **`Number(x)||0` / `?? 0` on a payload field is the fabricated-zero shape** — a missing field rendered "0 · on-chain agrees" green on the QA scorecard until 10-20. Throw when the field is absent.
- **Verify a dashboard's SQL without opening it:** run the page in jsdom with a recording `mcp` stub to capture its first-load queries, then `EXPLAIN` each in production through a `pg_temp` function (recipe: `docs/reference/tooling-gotchas.md`, "Added 2026-10-20"). Do it after any schema change a dashboard reads.
- **Probe the tool once in chat first** to see the real response shape before wiring it — connector wrappers reshape output vs the raw API.
- **The first open asks the viewer to allow each connector for that page** ("Continue"). Until Trevor allows it, every panel shows "could not run (approval_required / not_in_manifest)". A browser check from a session cannot get past that prompt without clicking a grant, which is Trevor's to give — say "not live-verified" rather than implying it.
- Heavy aggregate queries (e.g. the wmc scans) need a busy-skip guard or a bounded/precomputed source — see `rpc-data`.
- ⛔ **Never derive "last refreshed" for a materialized view from `pg_stat_all_tables.last_autoanalyze`.** Postgres stores no refresh timestamp; the authoritative instrument is `cron.job_run_details` joined to `cron.job` (`max(start_time) filter (where status='succeeded')`). An MV with no refresh job is the real finding.

## Brand stack (match the estate — it is all dark)

- **Dark theme, deliberately single-theme:** near-black bg (`#0c0c0e`), light text, `:root{color-scheme:dark}`, an explicit `body` background.
- **Accent = RPC red `#E03A2F`** on KPI values, the `h1` underline, section-header rules. Hardcoding the hex inside an artifact is fine (the no-literal rule is for the app repo); never add a second accent.
- **Display headings** UPPERCASE + letter-spaced; **numbers, wallets, pills** in monospace.
- **Libraries:** load only from the Artifact CSP allowlist, pinned to an exact version (the estate uses `chart.js@4.5.0/dist/chart.umd.js` from jsDelivr with `integrity` + `crossorigin`). Everything else inline. `localStorage` only for per-viewer conveniences, wrapped in try/catch.

## Durable vs ephemeral (the discipline)

- Build DURABLE dashboards that re-query live data. Do NOT bake point-in-time numbers into headings or prose the live query already returns (frozen "143 wallets"-style labels are the common drift).
- A one-off investigation snapshot is EPHEMERAL — fine to make, but retire it once the mission closes.
- `rpc-daytime-monitor` validates the estate via backing-object row probes, so point each dashboard at a stable view/table/RPC that returns rows.

## Update / retire

- Update: edit `docs/cowork-skills/<name>.html`, copy it to a scratch path, publish (with the artifact's `url` from another conversation), `cmp` scratch vs repo, run the helper test + the audit script, commit + ledger in the same turn.
- Retire: delete the artifact only when Trevor asks (the Artifact tool's delete is permanent and confirmed by him); otherwise republish a small on-brand "Retired — superseded by <x> / mission closed <date>" tombstone and `git rm` nothing until he decides.
