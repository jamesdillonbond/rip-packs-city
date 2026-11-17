# Handoff — kill the every-5-min full seq scan of `wallet_moments_cache` (backfill FMV-confidence)

> ✅ **RESOLVED 2026-08-18 — BOTH HALVES. Do not re-run this handoff.**
> **(1) The index shipped**: `idx_wmc_fmv_conf_null` is valid/ready/4,400 kB, built `CONCURRENTLY` from a
> one-statement pg_cron job (which also overturned the recorded "CONCURRENTLY is unreachable here").
> The every-5-min seq scan is gone. **(2) The follow-on starvation shipped**: killing the scan made the
> tick fast but not productive — it still converted ~0, because `LIMIT p_limit` sits inside the `targets`
> CTE **above the join**, so every tick re-read the same unresolvable `disney_pinnacle` head. Jobid 302 now
> rotates `p_collection_id` (Top Shot → All Day → UFC → Golazos, Pinnacle excluded on purpose); measured
> unscoped **0** vs scoped **1,000**, verified in production All Day 33,861 → 32,861.
> ⚠ **One claim in this handoff is REFUTED**: it states job 302 "failed 31 of 31 runs, every one
> `canceling statement due to statement timeout`". Re-read from `cron.job_run_details` it was **41
> succeeded / 31 failed**, and every failure was **`job startup timeout`** — the tick never launched.
> So the "strictly wasteful, nothing is lost by pausing it" justification did not hold.
> Detail: `docs/overnight/inbox/2026-08-18T1725Z-…` and `…T1835Z-…`.

**Date:** 2026-08-18 (~08:3x PT) · **Author:** daytime monitor (read-only), handed to Trevor / Claude Code
**Type:** DB-only. No git, no route/tsx/worker change. Apply the index directly via Supabase (SQL editor or `execute_sql`). Latest prod HEAD when written: `c50ef186`.

## Context

Investigating a live saturation spell (08-18 15:0xZ, 30/35 active sessions in IO wait), the single clearest avoidable IO drain on the hot table `wallet_moments_cache` (2.29M live rows, 874 MB heap, 2.6 GB total incl. indexes) is the FMV-confidence backfill cron. It does a **full seq scan of the heap every 5 minutes**. This handoff adds one partial index to eliminate that scan. It is additive and low-risk. Nothing else here needs shipping.

## The finding (measured)

`cron.job` **jobid 302 `rpc-backfill-wmc-fmv-confidence`**, schedule `2-59/5 * * * *` (every 5 min, ~288×/day), runs:

```
SELECT public.backfill_wmc_fmv_confidence(NULL, 1000);
```

The function's target-selection CTE is:

```sql
SELECT wmc.id, wmc.collection_id, wmc.edition_key
FROM public.wallet_moments_cache wmc
WHERE wmc.fmv_confidence IS NULL
  AND wmc.edition_key IS NOT NULL
  AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
LIMIT p_limit
FOR UPDATE SKIP LOCKED
```

There is **no index whose predicate matches `fmv_confidence IS NULL`.** The one partial index that looks related, `idx_wmc_fmv_null`, is `WHERE fmv_usd IS NULL` — a *different column*. So the planner seq-scans.

Verified with `EXPLAIN` (read-only, no ANALYZE) on the exact target query:

```
Limit  (cost=0.00..245.23 rows=1000 width=46)
  ->  LockRows  (cost=0.00..140409.77 rows=572559 width=46)
        ->  Seq Scan on wallet_moments_cache wmc  (cost=0.00..134684.18 rows=572559 width=46)
              Filter: ((fmv_confidence IS NULL) AND (edition_key IS NOT NULL))
```

~572k rows currently qualify, so it scans the whole 874 MB heap to pick off 1000 — every 5 minutes, forever (new rows arrive with `fmv_confidence` NULL, so it never drains to nothing). Even once drained it would keep seq-scanning to return zero rows.

**Caller enumeration:** the only caller is cron jobid 302 (verified via `cron.job` command search; no `app/**`, `lib/**`, `scripts/**`, or `supabase/**` reference — repo grep returned nothing). So a fix to the target-scan path affects nothing but this cron.

## Interim mitigation — pause the cron NOW to open the idle window (do this first)

Measured 2026-08-18 PM: jobid 302 `rpc-backfill-wmc-fmv-confidence` **failed 31 of 31 runs in the last 6 hours**, every one `canceling statement due to statement timeout` on its `WITH targets AS (…)` seq scan (the function's `statement_timeout` is 120s, and the seq scan no longer finishes inside it under load). So right now the job is strictly wasteful: every 5 minutes it seq-scans the full 874 MB heap, is killed at 120s, and writes **zero** rows — while competing for IO with the marathon autovacuum on the same table. It is safe and reversible to pause it, and doing so removes a known-useless IO load and helps the DB reach the idle state the CONCURRENTLY build needs.

```sql
-- pause (reversible). accomplishes nothing while failing, so no coverage is lost that wasn't already lost.
SELECT cron.alter_job(302, active := false);
-- resume AFTER the index is built (it will then succeed cheaply via the index):
-- SELECT cron.alter_job(302, active := true);
```

Recommended sequence: (1) pause jobid 302; (2) let IO settle and the autovacuum finish; (3) when the idle test below passes, run the DROP + CREATE; (4) resume jobid 302. Confirm the resumed job succeeds (`SELECT * FROM cron.job_run_details WHERE jobid=302 ORDER BY start_time DESC LIMIT 3;` → `succeeded`).

## ⚠ UPDATE 2026-08-18 PM — an INVALID `idx_wmc_fmv_conf_null` already exists; do NOT use `IF NOT EXISTS`

A first CONCURRENTLY build was cancelled (DB was at 100% IO wait with an hour-plus autovacuum on this same table; a plain non-concurrent build takes `ACCESS EXCLUSIVE` on the hottest table product-wide — correctly aborted rather than cause a lock convoy). It left a stub index: confirmed `indisvalid=false, indisready=false, 0 bytes`. It is inert (writes ignore it), **but it means the original `CREATE INDEX CONCURRENTLY IF NOT EXISTS` below would silently no-op and report success against a dead index.** Drop first. Trevor has filed the canonical ready-to-fire SQL + an idle-window test alongside this; that filing is authoritative if it disagrees with the block here.

## The fix — drop the stub, then add the matching partial index

Run in **one idle window**, as **two standalone statements** (CONCURRENTLY cannot run inside a transaction, so **do not** use `apply_migration` — use the SQL editor or two separate `execute_sql` calls). Gate on an idle DB first (see idle test below):

```sql
-- 1. remove the inert/invalid stub left by the cancelled build (no IF NOT EXISTS trap)
DROP INDEX CONCURRENTLY IF EXISTS public.idx_wmc_fmv_conf_null;

-- 2. build it for real (NOT "IF NOT EXISTS" — you want this to fail loudly if a stub is still present)
CREATE INDEX CONCURRENTLY idx_wmc_fmv_conf_null
  ON public.wallet_moments_cache (collection_id, edition_key)
  WHERE fmv_confidence IS NULL AND edition_key IS NOT NULL;
```

**Idle test before you start** (only build when IO wait is low — a CONCURRENTLY build still reads the whole table twice):

```sql
SELECT count(*) FILTER (WHERE wait_event_type='IO') AS io_wait,
       count(*) FILTER (WHERE state='active') AS active
FROM pg_stat_activity WHERE pid <> pg_backend_pid();
-- proceed only if io_wait is a small fraction of active (e.g. < ~20%).
```

After it completes, confirm the object is real, not another stub:

```sql
SELECT indisvalid, indisready FROM pg_index WHERE indexrelid = 'public.idx_wmc_fmv_conf_null'::regclass;
-- expect: t, t
```

**Why a NEW index and not just repoint the function at `fmv_usd IS NULL`:** the sibling cron `refresh_wmc_fmv_changed` (jobid 303) sets **`fmv_usd` only, never `fmv_confidence`**. So rows can have `fmv_usd` populated while `fmv_confidence` is still NULL — `fmv_confidence IS NULL` and `fmv_usd IS NULL` are genuinely different sets. Swapping the predicate would silently skip rows that still need a confidence value. The index matching the real predicate is the correct, behavior-preserving fix.

Index cost is low: it's partial over the NULL set (and that set is what the job is actively draining), leading column `collection_id` also serves the optional `p_collection_id` filter. Write amplification is negligible — inserts/updates already touch this table; this only maintains membership of the shrinking NULL subset.

## Verify after applying

1. Re-run the `EXPLAIN` above → expect an **Index Scan / Bitmap Index Scan on `idx_wmc_fmv_conf_null`**, not a Seq Scan.
2. Confirm the job still does its work: `SELECT public.backfill_wmc_fmv_confidence(NULL, 1000);` should return a similar non-zero count to before (it's the same rows, found faster).
3. Watch IO: over the next hour, `SELECT count(*) FILTER (WHERE wait_event_type='IO') FROM pg_stat_activity WHERE state='active';` should trend down at the :02/:07/:12… minute marks that previously carried the seq scan. (Measure in a quiet window — a concurrent spell will mask it.)

## Revert

```sql
DROP INDEX CONCURRENTLY IF EXISTS public.idx_wmc_fmv_conf_null;
```

No function, cron, ACL, or data change — purely additive index. Reverting restores the seq-scan behavior and nothing else.

## What is deliberately NOT in scope (checked, and honestly not the lever)

- **`refresh_wmc_fmv_changed` (jobid 303, every 10 min, batch 200k)** — inspected the body; it is well-built: incremental cursor via `rwfc_state.last_cutoff`, only processes editions whose FMV *changed*, 5-row chunks, a deadline budget, and a `wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd` guard so it never rewrites an unchanged row. Not wasteful churn. Leave it.
- **Dropping indexes to cut write amplification** — checked `pg_stat_user_indexes`: **every** index on the table is used (minimum 617 scans; `idx_wmc_moment_collection_cover` has 99M). No dead index to drop.
- **Lowering `fillfactor` for HOT updates** — would not help the write paths here. The backfill flips the `idx_wmc_fmv_null` partial-predicate and touches `idx_wmc_cohort_cover`'s `INCLUDE (fmv_usd)`, and the routine `lock_checked_at` refreshes touch three `lock_checked_at` indexes — all non-HOT by construction regardless of fillfactor. (I floated fillfactor in chat before measuring; the index design defeats it. Noted so it isn't re-tried.)
- **Autovacuum tuning** — the 33-min mid-day `VACUUM wallet_moments_cache` seen during the spell is downstream of the churn/scan load; cutting the seq scan is the upstream fix. Don't raise `autovacuum_vacuum_cost_limit` (spikes IO) as a first move.

## Optional follow-up (not required)

Once the index is in, the 5-min cadence of jobid 302 is cheap even when it finds nothing, so cadence tuning is unnecessary. If you later want the NULL backlog drained faster, raise the batch (`backfill_wmc_fmv_confidence(NULL, 25000)` — the function default) temporarily rather than the frequency; with the index the larger scan is bounded to the partial set.

## Guardrails

- **Direct to `main`, no branches/PRs** if you record the inverse migration. This change itself is DB-only and applied live.
- **`CREATE INDEX CONCURRENTLY` must be standalone** — not inside `apply_migration`'s transaction. Use the SQL editor or a single `execute_sql`. A cancelled/failed build leaves an `INVALID` stub (this already happened, 2026-08-18) — **always `DROP CONCURRENTLY` first and build without `IF NOT EXISTS`**, or a retry silently skips and falsely reports success.
- Prefer a **low-IO window** to build it (the build itself reads the table); during a saturation spell the CONCURRENTLY build will be slow — fine to wait for quiet.
- **Claude Code's / Trevor's direct inspection of the live DB wins over this doc on any disagreement** — adapt to the actual object shapes if they've moved since 2026-08-18.

**Expected end state:** `idx_wmc_fmv_conf_null` exists; the backfill's `EXPLAIN` shows an index scan; the every-5-min full-heap seq scan of `wallet_moments_cache` is gone, removing ~288 heap scans/day of IO during the platform's worst-contended table.
