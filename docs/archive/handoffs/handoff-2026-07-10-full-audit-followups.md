# Claude Code handoff — 2026-07-10 full-audit follow-ups

## Context
Cowork ran a full platform audit on 2026-07-10 and shipped everything it safely could **live already** — 4 DB migrations (via Supabase MCP) + 3 code commits pushed to `main`:
- `4969aef` fix(packs): hide stress-test dists on all boards; humanize tier chips; em-dash for $0 price.
- `5039463` fix(ops): misattrib-drain fatal crash-logger; allday-listing-cache falls back to topshot-proxy `/allday-consumer`.
- `1f1f382` docs: full audit report + roadmap + ledger/session log.
- Migrations (live): `audit_20260710_circ_floor_raise_impossible_parallel_stragglers` (trust breach 4→0), `_pack_dist_title_mojibake_fix` (43 titles), `_allday_pack_dist_totals_sync` (+ pg_cron `rpc-sync-allday-pack-dist-totals`), `_pack_table_rows_depletion_coalesce`.

**HEAD at handoff:** `5039463` on `main`. Deploy `dpl_3HuSv921` READY. CI + smoke green. Full findings: `docs/audits/full-audit-2026-07-10.md`. This handoff covers what Cowork could NOT do from its sandbox (no git creds for route pushes are fine — those are done; the blockers below are Windows-host shell, Vercel env writes, and product decisions).

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## 1. Restart the two dead home-machine ingests (HIGH, Windows-host shell — do first)
Both are Windows Task Scheduler jobs that need this machine's **residential** egress (Atlas/dapper.market WAFs Vercel + GitHub datacenter IPs). Both stopped ~2026-07-07 (likely a reboot/logoff — they're "run only while logged on"):
- **"RPC Deal Board Ingest"** — `topshot-active-listings-ingest`, every 3h; feeds special-serial live asks. Last ok in `pipeline_runs`: 2026-07-07 22:13Z.
- **"RPC AllDay Badge Ingest"** — `allday-badge-ingest`. Last ok: 2026-07-06 12:37Z.

Run + confirm (PowerShell):
```powershell
Start-ScheduledTask -TaskName "RPC Deal Board Ingest"
Start-ScheduledTask -TaskName "RPC AllDay Badge Ingest"
Get-ScheduledTask | Where-Object {$_.TaskName -like "RPC*"} | Get-ScheduledTaskInfo | Select TaskName,LastRunTime,LastTaskResult,NextRunTime
```
`LastTaskResult` 0 = success. Then confirm the pipeline advanced:
```sql
SELECT pipeline, max(started_at), bool_or(ok) FROM pipeline_runs
WHERE pipeline IN ('topshot-active-listings-ingest','allday-badge-ingest')
  AND started_at > now() - interval '30 minutes' GROUP BY pipeline;
```
Logs if a run fails: `%LOCALAPPDATA%\rpc-deal-board-ingest\ingest.log` and `%LOCALAPPDATA%\rpc-allday-badge-ingest\`. If they keep dying on logoff, consider "Run whether user is logged on or not" in each task's General tab (needs the machine to stay on) — Trevor's call.

## 2. Umbrella AllDay proxy env var (MED, Vercel env write — do second)
Cowork patched the ONE proven-broken leg (`app/api/allday-listing-cache/route.ts` now falls back to the worker). But four callers read AllDay consumer GQL and all default to the now-WAF-403'd `nflallday.com/consumer/graphql` when `ALLDAY_PROXY_URL` is unset: `lib/editions-hydrate.ts`, `app/api/allday-fmv-populate/route.ts`, `app/api/allday-seed-editions/route.ts`, `app/api/sniper-feed/route.ts` (grep `ALLDAY_PROXY_URL` to confirm — 5 files). Setting the env var fixes all of them centrally and lets us revert the hardcoded fallback later.
```powershell
# POST https://api.vercel.com/v10/projects/prj_YBJ6Utl32GfyBOIzbsp3kbshJh96/env?teamId=team_YWGCVToPBJSS60NgVh8jiCFV
# body: { "key":"ALLDAY_PROXY_URL", "value":"https://topshot-proxy.tdillonbond.workers.dev/allday-consumer", "type":"encrypted", "target":["production"] }
# via Invoke-WebRequest (curl no-ops silently in Git Bash). Then redeploy (POST /v13/deployments, gitSource ref main).
```
Verify the worker route auths (it 401s without the secret, which is correct — prod sends `X-Proxy-Secret` from `TS_PROXY_SECRET`). After deploy, `allday-fmv-populate` should log editions_fetched>0.
**Revert:** delete the env var + `git revert` the `5039463` allday leg if the proxy path misbehaves.

## 3. Verify the two 07-10 ops fixes on their next ticks (LOW, watch)
- `allday-listing-cache` (`*/20`): next tick's `pipeline_runs.extra` should show `total_listed > 0` and `marketplace_complete: true` (was `returned 0 rows`). If still 403, the worker route needs the AllDay marketplace host added (`workers/topshot-proxy/index.js` — the marketplace query hits `public-api.nflallday.com`, not `/consumer`; confirm the worker forwards it).
- `drain-topshot-misattribution` (daily 11:00Z Vercel cron): the 07-10 crash-logger will now write an `ok=false` `pipeline_runs` row with `extra->>'error'` on the next tick. Read it and fix the actual root cause (500 since 07-07, zero output → suspect an import/env failure introduced 07-06→07-07; `git log --since=2026-07-06 -- app/api/admin/drain-topshot-misattribution/ lib/`). Revert crash-logger: `git revert 5039463`.

## 4. UFC → Aptos honest UI state (MED, product decision → code)
ufcstrike.com now banners "MIGRATE TO APTOS". Flow UFC market frozen since 2026-05-13 (813,435 historical sales intact; cached_listings UFC = 1 row; dapper.market doesn't list UFC). **Trevor's call first**, then implement: mark UFC "historical / migrated to Aptos" in the collection header + market/sniper empty states, and stop the UFC live-market crons (`ufc-listings-indexer` etc. — they tick and find nothing). Keep 813k historical sales browsable. Do NOT add an Aptos indexer (out of the chain-two thesis; Candy/Solana is chain two, deferred to ~Sep).

## 5. Lower-priority queued (from docs/audits/full-audit-2026-07-10.md)
- Soft-404: streamed `notFound()` pages return 200 + doubled-suffix title + wrong canonical (`/nba-top-shot/team/ogs`, exhibition teams, UUID-fossil editions). Add `noindex` meta or 404 status on the streamed notFound path. Not in sitemap, so LOW.
- Recharts SSR warning spam (`width(-1)/height(-1)`) on edition pages — `FmvHistoryChart` container needs an explicit min height. Cosmetic log noise.
- AllDay serial/jersey FMV port — biggest parity win; the TS serial power-model + jersey overload exist (`serial_fmv_estimate`), AllDay special-serial owners board is already live. Needs `editions.jersey_number` coverage for AllDay first. Larger effort — spec before building.

---

## Guardrails (every RPC handoff)
- **Direct to `main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, `git checkout main` first.
- Commit via **PowerShell** `git` on Windows (Git Bash `git commit` can silently no-op). Re-verify: `git rev-list --count origin/main..HEAD` (expect 0 after push).
- **`curl` no-ops silently in Git Bash** for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** — higher sends the deploy to ERROR invisibly.
- CRLF: full-file writes or `findIndex` on split lines; never string-replace-patch on Windows.
- Run `npx tsc --noEmit` before pushing; confirm the Vercel deploy reaches READY and smoke tests pass.

## Expected end state
Both home ingests green in `pipeline_runs`; `ALLDAY_PROXY_URL` set so all AllDay consumer-GQL callers route through the worker (editions_fetched>0); misattrib-drain's real error surfaced and fixed; UFC presented honestly. Trust health stays 16/16, security 0/0/0/0.
