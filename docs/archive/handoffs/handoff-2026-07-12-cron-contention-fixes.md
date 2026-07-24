# Handoff — overnight cron-failure investigation + fixes (2026-07-12, Cowork interactive)

Trevor asked "why did so many cron jobs fail overnight." Root-caused and fixed the bulk **DB-side (live now)**. One code follow-up is blocked by the sandbox git/bash provisioning outage (see bottom) and is handed off here.

## TL;DR root cause

The overnight failures were **not** the recurring cron-job.org trigger dropout and **not** an overnight spike — the pipeline failure rate was a flat ~2–4% across the whole 30h window, day and night. Two real, compounding causes:

1. **pg_cron heavy jobs were silently capped at 120s.** Every failing pg_cron job died at *exactly* 120s. They run as `postgres`, which inherits the cluster's 120s `statement_timeout`. The `statement_timeout=600s` set in each fit function's proconfig on 2026-06-30 **never applied on the cron path** — `statement_timeout` is armed once when the top-level `SELECT fn()` statement begins, and a function-level `SET` cannot re-arm the already-running statement. So the 06-30 "fix" was inert; the jobs kept dying at 120s.
2. **`pipeline_runs` had bloated to 85K rows / 70 MB** (target ~9.5K). At ~10K runs/day, 7-day retention structurally yields ~85K rows; the cleanup's big DELETE was contending with the constant insert stream. The bloat slowed every pipeline's cursor read (which had no matching index) and the health scans — a feedback loop feeding the contention.
3. **`topshot-buyer-backfill` (97% fail) / `allday-buyer-backfill` (100% fail)** — the null-buyer SELECT sorted ~1.67M rows across all `sales` partitions to return 100, crossing the 30s service-role ceiling as the reachable-null set thinned.

## SHIPPED (DB-side, live now)

### pipeline_runs bloat + cleanup reliability
- **Drained 85,054 → 20,265 rows** (kept last 2 days; chunked index-backed DELETEs) + `VACUUM (ANALYZE)`.
- **Added cursor-read index** `pipeline_runs_pipeline_started_idx (pipeline, started_at DESC)` — every pipeline's `WHERE pipeline=X ORDER BY started_at DESC LIMIT 1` cursor read was previously unindexed (the existing composite is on `finished_at`). Revert: `DROP INDEX CONCURRENTLY public.pipeline_runs_pipeline_started_idx;`
- **`prune_pipeline_runs` got 120s headroom**: `ALTER FUNCTION public.prune_pipeline_runs(integer) SET statement_timeout='120s';` so a large prune can't trip the 30s ceiling. Revert: `ALTER FUNCTION public.prune_pipeline_runs(integer) RESET statement_timeout;`
- **Moved the cleanup in-DB** (reliable, no external HTTP trigger): new pg_cron job `rpc-prune-pipeline-runs` (jobid 57), `41 */6 * * *`, `SELECT public.prune_pipeline_runs(3)` — keeps ~3 days (~30K rows). The cron-job.org "RPC Pipeline Runs Cleanup" entry is now redundant (harmless; operator may disable). Revert: `SELECT cron.unschedule('rpc-prune-pipeline-runs');`

### pg_cron statement-timeout fix + stagger — migration `audit_20260712_pgcron_stmt_timeout_and_stagger`
Set a **job-level `SET statement_timeout`** on each capped job (a top-level SET *does* re-arm the timer for the following statement) + spread the daily/weekly heavy jobs out of overlapping/busy windows. Validated the mechanism live: ran `SET statement_timeout='600s'; SELECT public.dedup_allday_cross_source_sales();` from a 120s session → completed cleanly (returned 0).

| job | change |
|---|---|
| 3 rpc-ccm-step1 | +600s (sched kept `10 4`) |
| 6 serial-fmv-power (TS) | +600s, `0 11 * * 0` → `50 11 * * 0` |
| 7 remap-misattrib-sales | +600s (sched kept `23 */6`) |
| 8 thin-fmv-guard | +300s, `30 13` → `30 8` |
| 13 attribute-pack-rips | +600s, `40 9` → `10 3` |
| 28 allday-ev-corrected (REFRESH…CONCURRENTLY) | de-collide only `23 */6` → `47 */6` (can't take a SET prefix — multi-statement txn breaks CONCURRENTLY) |
| 30 serial-fmv-jersey (TS) | +600s, `5 11 * * 0` → `35 11 * * 0` |
| 32 cross-source-dedup | +600s (sched kept `40 * * * *`) |
| 33 fmv-display-guard | +300s, `45 13` → `45 8` |
| 34 fmv-clamp | +300s, `55 13` → `55 8` |
| 46 misattrib-candidates | +600s, `45 10` → `25 3` |

**Validation window:** jobs 7/28/32 validate on today's next ticks; ccm-step1 tomorrow 04:10 UTC; the two TS serial-FMV fits next Sunday (11:35 / 11:50 UTC). Watch `check_pgcron_recent_failures()`.

**Revert (restore originals):**
```sql
SELECT cron.alter_job(job_id=>3,  command=>'SELECT public.refresh_cross_collection_cohort_step1();');
SELECT cron.alter_job(job_id=>6,  schedule=>'0 11 * * 0',  command=>'SELECT public.compute_serial_fmv_power_model();');
SELECT cron.alter_job(job_id=>7,  command=>'SELECT public.remap_misattributed_topshot_sales(); SELECT public.refresh_topshot_conflated_editions_detector_only();');
SELECT cron.alter_job(job_id=>8,  schedule=>'30 13 * * *', command=>'SELECT public.refresh_topshot_thin_fmv_editions();');
SELECT cron.alter_job(job_id=>13, schedule=>'40 9 * * *',  command=>'SELECT public.attribute_topshot_rips_empirical(20000);');
SELECT cron.alter_job(job_id=>28, schedule=>'23 */6 * * *');
SELECT cron.alter_job(job_id=>30, schedule=>'5 11 * * 0',  command=>'SELECT public.compute_serial_fmv_jersey_model(p_lookback_days => 365);');
SELECT cron.alter_job(job_id=>32, command=>'SELECT public.dedup_allday_cross_source_sales();');
SELECT cron.alter_job(job_id=>33, schedule=>'45 13 * * *', command=>'SELECT public.refresh_topshot_fmv_display_guard();');
SELECT cron.alter_job(job_id=>34, schedule=>'55 13 * * *', command=>'SELECT public.fmv_clamp_disconnected_ask_topshot(false);');
SELECT cron.alter_job(job_id=>46, schedule=>'45 10 * * *', command=>'SELECT public.refresh_topshot_misattrib_candidates();');
```

Note: the `compute_serial_fmv_*` functions still carry an (ineffective-on-cron-path) `statement_timeout=600s` proconfig. Harmless to leave; the job-level SET is what now works.

### buyer-backfill SELECT timeout — 7 partial indexes
The null-buyer SELECT sorted ~1.67M rows; now index-fed. Built `idx_sales_<YYYY>_ts_nullbuyer` on each `sales_2020…2026` partition: `(sold_at DESC) WHERE buyer_address IS NULL AND transaction_hash IS NOT NULL AND collection='nba_top_shot'`. EXPLAIN of the forward query flipped from `Limit (cost=183235…)` + 1.67M-row Sort → `Limit (cost=2.70..11.63)` index-scan merge (~15,000× cheaper first-100). Failures stop. Revert: `DROP INDEX CONCURRENTLY public.idx_sales_2020_ts_nullbuyer;` … through `_2026_`.

## CODE FOLLOW-UP (blocked by sandbox outage — needs a deploy)

**buyer-backfill forward-lane bound to 2025+ (efficiency; LOW priority).** The indexes stop the *failures*, but the forward lane still walks the ~1.03M **unreachable** pre-2025 null-buyer rows (current-spork REST can't decode them — that's the inert historical/spork lane's job), wasting runs (`rows_written≈0`) until the cursor wraps. The forward lane is *designed* for 2025+ (`HIST_WINDOW_END = 2025-01-01`); the forward query just never got the matching lower bound. Add to the forward query in both routes:

- `app/api/admin/backfill-topshot-buyers/route.ts` (the main `after()` lane, ~line 261): add `.gte("sold_at", "2025-01-01T00:00:00Z")` to the `sales` select.
- `app/api/admin/backfill-allday-buyers/route.ts` (~line 177): same `.gte("sold_at", "2025-01-01T00:00:00Z")`.

Effect: partition-prunes to `sales_2025`/`sales_2026`, so the lane focuses on the ~640K reachable rows + keeps up with the ~270/day inflow instead of churning history. (AllDay predicate is `buyer NULL OR escrow-router`; the existing `.or()` still works — the 2025 bound just prunes partitions.)

No `KEEP_DAYS` change needed for the prune route — the new in-DB pruner (jobid 57) owns retention now.

## Sandbox / git outage
`mcp__workspace__bash` failed all session with `useradd: cannot create directory /sessions/…` (a Cowork VM user/home provisioning failure, same class the 2026-07-12 overnight pass hit → "BASH/GIT-SANDBOX-PROVISION-FAILURE"). It's infra-side, not the repo. DB/MCP work is unaffected (all of the above shipped via Supabase MCP). Only the git-push / Vercel-deploy path is blocked → the one code item above is handed off. Fix: fresh Cowork session (re-provisions the VM) usually clears it; if it persists across sessions, it's a workspace-provisioning issue for Cowork support.
