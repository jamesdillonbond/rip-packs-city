# Claude Code handoff — 2026-07-16: IOPS read-diet + roadmap execution

**Context.** Cowork shipped live tonight (all verified): `get_pack_lifecycle_row` + `get_pack_realized_ev_row` per-dist SECDEF RPCs (migration `audit_20260716_pack_lifecycle_realized_perdist_rpcs`; outputs verified row-identical to the views on dist 5048) and, on 07-14, `get_pack_market_row` + `idx_pack_purchases_dist_sale_price`. Code shipped alongside (same session, pushed to main): pack-page repoint to the two new RPCs, sentinel empty-error fix, set/player soft-404 hardening. Current HEAD at handoff time: check `git log` — Cowork's last commit message starts `fix(sentinel+pack-perf)`. **The items below are what remains.** Read `docs/overnight/ledger.md` (2026-07-14 + 2026-07-16 Cowork entries) first.

Root-cause summary you need: the July 13–15 site-wide degradation was **disk-IOPS burst exhaustion** on the Supabase Micro instance (pg_stat_statements: `populate_wmc_fmv_from_snapshots` **10.9 TB read / 44,139 calls ≈ 248 MB/call at ~65s cadence** via the `wmc-fmv-populate` cron chain; `refresh_wmc_fmv_drift_active` **4.6 TB / 8,742 calls**). It recovered by 07-16 (market RPC 0.55s), but the standing read volume WILL re-pin the budget. Items 1–2 are the durable fix.

---

## 1. wmc FMV denorm read-diet (HIGH — the #1 IOPS lever)

- **Where:** DB functions `public.populate_wmc_fmv_from_snapshots(p_collection_id, p_force, p_limit)` and `public.refresh_wmc_fmv_drift_active(p_deviation_pct, p_limit)`; caller is the `wmc-fmv-populate` edge-fn/cron chain (cron-job.org, ~65s cadence, 5 collections/tick).
- **What/why:** each call re-reads ~248 MB — almost certainly a full wmc × latest-fmv_snapshots re-join per tick instead of a delta. EXPLAIN the inner scans first (memory: `[[measure-loop-before-prescribing-batch-rewrite]]`). Likely fix shape: drive off editions whose latest `fmv_snapshots.computed_at` changed since the last tick (delta set is small), not the full cache. **FMV-adjacent wmc write path — Trevor reviews the rewrite before it ships.**
- **Cadence lever (operator, zero-code):** wmc FMV staleness of 10–15 min is invisible to users; cut the cron-job.org cadence 65s → 10 min while the rewrite bakes. (Console is operator-only.)
- **Verify:** pg_stat_statements read_gb/call for the fn drops ~100×; Supabase dashboard Disk-IO-budget graph stays >50%.
- **Revert:** restore prior fn definitions from migration history; cadence back to current.

## 2. Team-page 30d volume precompute (MED — throttle resilience)

- **Where:** DB fn `public.get_team_detail(uuid, text)` (line ~88, the 30d `sales JOIN editions WHERE team_name = ANY(v_team_variants)` aggregate). Consumer: `app/(collections)/[collection]/team/[slug]/page.tsx` (no code change needed if the fn keeps its signature).
- **What/why:** the live per-request 30d aggregate ran 66–120s+ under throttle (soft-404'd Blazers/Chiefs on 07-14 — measured, EXPLAIN in ledger). Precompute per-team 30d volume/count into a small rollup (nightly pg_cron as `cron_heavy`, one grouped scan for all teams) and have `get_team_detail` read the rollup. Note the June "team-page perf fine as-is" disposition predates the IOPS regime — the *activity* LATERAL advice still stands, this is only the detail fn's 30d leg.
- **Verify:** `SELECT * FROM get_team_detail('95f28a17-...','portland-trail-blazers')` <2s cold; team pages render <10s.
- **Revert:** restore prior `get_team_detail`; drop the rollup + cron job.

## 3. TS thumbnails one-shot (LOW — 82 actively-trading art-less editions)

- **Where:** a one-shot script (pattern: `scripts/` + topshot-proxy GQL `searchEditions`) or a temporary extension of the existing catalog path. Convention: only the topshot-catalog-backfill lane writes `editions.thumbnail_url` (memory `[[rpc-new-drop-ingestion]]`) — keep the write shape identical.
- **What/why:** 6,558 no-thumb TS base editions, ~82 with 30d sales / ~253 with recent FMV (verified 07-14). `topshot-onchain-art-backfill` is exhausted (`no_more_editions`, 180 resolver misses). Target ONLY the active set: `SELECT external_id FROM editions e WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id NOT LIKE '%::%' AND thumbnail_url IS NULL AND EXISTS (SELECT 1 FROM fmv_snapshots f WHERE f.edition_id=e.id AND f.computed_at > now()-interval '7 days')`.
- **Verify:** re-run that query → ~0; spot-check 3 edition pages render art.
- **Revert:** `UPDATE editions SET thumbnail_url=NULL WHERE updated_at > '<run start>' AND ...` (log the touched external_ids from the script).

## 4. Underpriced-#1s ingest revival (OPERATOR — Trevor's machine)

- Atlas 403s **all** datacenter egress since ~07-13 10:31Z (GHA runner curl AND browser-header curl blocked; the Pinnacle finding proved CF-Workers egress is blocked too — do NOT build a worker passthrough). Residential lane only: re-register the home-machine Task Scheduler job (`scripts/register-active-listings-task.ps1` → `scripts/run-active-listings-ingest.ps1`), which also revives the AllDay-badges home ingest (down since ~07-07). Consider disabling the now-permanently-failing GHA `topshot-active-listings-ingest.yml` schedule (keep workflow_dispatch) so Actions stops flapping red.
- **Verify:** `pipeline_runs` shows `topshot-active-listings-ingest` ok=true; the underpriced board's asks freshen (<3h).

## 5. ownership-sync-dune retrigger (OPERATOR one-liner)

- Weekly tick failed 07-13 11:45Z (pool timeout during the throttle); `topshot_ownership` / Top Owners modules are stale until 07-19 unless retriggered. PowerShell (curl is unreliable in Git Bash):
```powershell
Invoke-WebRequest -Method POST -Uri "https://www.rippackscity.com/api/cron/ownership-sync-dune" -Headers @{ Authorization = "Bearer $env:INGEST_SECRET_TOKEN" }
```
- **Verify:** `pipeline_runs` ownership-sync-dune ok=true; stay inside the free Dune credit tier (one manual run is fine).

## 6. AllDay 5%-rebate awareness line (LOW — free buy-side hook, ends 2026-09-09)

- **Where:** `components/marketplace-status/MarketplaceStatusBanner.tsx` (verified path; it already carries per-collection sunset/shutdown copy).
- **What:** on the AllDay variant add one line: marketplace buys through **Sep 9, 2026** earn a 5% Dapper Balance rebate (12-month hold on the purchased Moment) + Founding Collector designation. Source: https://blog.nflallday.com/posts/nfl-all-day-changes. Keep it factual, tokens not hex, no hype.
- **Revert:** git revert.

## 7. Roadmap pointers (pick up as capacity allows — see docs/strategy/roadmap-2026-07-14.md)

Mobile small-viewport pass; Pinnacle set-completion tracker (mirror the TS set-completion planner); AllDay Top Owners (Dune or wmc-approximate); catalog TS **Autographs** + **Redeem** attributes (first-class filters on v2.nbatopshot.com, invisible in RPC); wmc index rationalization (unique-idx decision — analysis in the 07-14 ledger entry, do NOT drop without checking uniqueness semantics).

---

**Guardrails (every handoff):** direct-to-`main`, no branches/PRs (if a `claude/*` branch is pre-checked-out, switch to `main` first). Commit via PowerShell `git` on Windows; re-verify push with `git rev-list --count origin/main..HEAD` (expect 0). `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`. Vercel Pro `maxDuration` hard cap **800s** (higher = invisible ERROR deploys). CRLF: full-file writes or `findIndex` on split lines, never naive string-replace patches. Run `npx tsc --noEmit` + `npm test` before push; watch the deploy to READY; the pack-dist + edition smoke probes should pass.

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

**Expected end state:** wmc denorm loop reads ~MBs not ~248MB/call and the Disk-IO budget stays green; team pages <10s under any load; the 82 active art-less editions filled; underpriced board + Top Owners fresh; rebate line live on AllDay surfaces; all commits direct on main with deploys READY.
