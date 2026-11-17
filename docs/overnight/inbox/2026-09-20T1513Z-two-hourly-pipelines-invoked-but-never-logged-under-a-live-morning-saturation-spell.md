# Daytime-monitor candidate — two pipelines `invoked_but_never_logged` during a live morning saturation spell

**Filed:** 2026-09-20 ~08:12 AM PT (rpc-daytime-monitor, first tick). **READ-ONLY sense pass.**
**Spell status at file time:** IN a saturation spell — positive control `pg_stat_activity` read **io_wait 15 ≥ active 13** (total 43), and `rpc_ops_snapshot()` **timed out** at the statement cap. Per skill Section 1c, everything below is filed as a **SYMPTOM**; no cause, cost, or "cheap/expensive" judgment is asserted. **Suggested action for every item = quiet-window RE-MEASURE, not a fix.**

## New observations (not in ledger/inbox) — the reason this file exists

Two watched pipelines are flagged by `detect_stalled_pipelines()` with classification `invoked_but_never_logged` (heartbeat fired, no success marker written) — the exact signature of a lane whose work starts and is killed before it can log, which is what a spell produces:

1. **`pinnacle-metadata-backfill`** — silent **647 min**, severity medium, last logged success **2026-09-20T04:22Z**, heartbeat_last_run 14:22Z, 10 uncorrelated heartbeats.
   - Source: `detect_stalled_pipelines()`.
   - Risk read: LOW-to-MEDIUM. Its last real success (04:22Z) **predates this morning's heavy-cron band**, so this is the one that might be a genuine stall rather than pure spell collateral — worth a look, but only once the box is quiet.
   - Suggested action: in a quiet window, re-run `detect_stalled_pipelines()`; if still stalled with io_wait low, read the lane's own error/`extra` (`pipeline_runs` + heartbeat correlation) — do NOT conclude a stall from a reading taken during a spell.

2. **`classify-acquisitions-multicollection`** — silent **243 min**, severity medium, `invoked_but_never_logged`, heartbeat_last_run 15:06Z, 4 uncorrelated heartbeats.
   - Source: `detect_stalled_pipelines()`.
   - Risk read: LOW. Hourly lane; fresh heartbeats + spell in progress ⇒ most likely killed-before-log collateral.
   - Suggested action: quiet-window re-measure; clears on its own if it was spell collateral.

(`atlas-market-events-prune` also listed at severity **info**, classification `no_marker` — by-construction no marker per its own note; **not a finding**.)

## Context only — ALREADY TRACKED, deliberately NOT re-filed

- **Acute morning saturation spell in progress.** `check_pgcron_recent_failures()` returns ~38 jobs, almost all `job startup timeout` / `canceling statement due to statement timeout` (atlas/pinnacle dispatch lanes 41 fails/717 runs). This is the **known #126** morning-band mechanism — ledger 2026-09-20 nightly (line ~90: "a disk-saturation instant at a minute boundary blacks out the launcher") and the #126 decomposition (line ~104). No autonomous lever; queued for Trevor. **Not re-filed.**
- **User-facing collateral (Vercel, 6h):** elevated read-timeouts across edition / team / player / pack-dist / set / insights surfaces, last-seen 15:0x–15:10Z, **all chronic error groups first-seen weeks ago** (edition `market_bundle` 104/38u, edition recent-sales degrading 87/68u, team activity 45/6u, pack-detail panels, etc.). Mostly **honest degrade** ("degrading to empty" / "degrading the SECTION"); one page-level throw path (`set editions … STRUCTURAL — throwing`, 4/3u) is the known structural branch. Same shapes the nightly pass logged at 08:16Z. **Not re-filed.**
- **`rpc-weekly-wmc-reindex-6` → `relation "public.idx_wmc_wallet_coll_ek_fmv" does not exist`** (last run 03:43Z, weekly). This is a genuine non-saturation logic error, but it is **already documented** (ledger 2026-09-19, "reindex-6 has been aimed at an index dropped on 09-14"). **Not re-filed.**
- **Cross-collection (1a):** `rpc-ccm-step1` failed 10:02Z and `rpc-ccm-step2` failed 10:35Z today, both `statement timeout` (spell collateral). The nightly pass verified the mats **fresh at 08:16Z**, so they are still within the 26h bar; note for the night pass in case a second consecutive day's refresh fails.

## Health summary (this run)
Security **clean** (RLS-off tables [], anon-write holes []). Vercel deploys **clean** (latest `775535e` READY; a concurrent session shipped R118 timeout-handler work this morning). Snapshot **timed out (spell)**; trust-health / cross-collection deep-verify / artifact payload validation **DEFERRED** this run per Section 1c (heavy payload queries stack IO onto a live spell and return uninterpretable timeouts).

## Drained 2026-09-22 — STALE BY THE SMALL→LARGE RESIZE — pinnacle-metadata-backfill and classify-acquisitions-multicollection both 24/24 ok in 24 h (09-22).

*(Per-item drained marker, the mechanism `docs/reference/autonomous-tasks.md` names as the unblock for archival. Re-derived live by the 2026-09-22 daytime Cowork pass; archiving remains Trevor's call.)*
