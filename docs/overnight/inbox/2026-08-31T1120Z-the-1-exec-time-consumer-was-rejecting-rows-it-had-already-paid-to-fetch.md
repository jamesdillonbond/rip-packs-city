> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T1120Z — the #1 exec-time consumer was rejecting rows it had already paid to fetch, and the pipeline behind it is 3.3% productive

**Session:** cloud, no-push. **Read at** `origin/main` `f2caec2`, cloned 10:59Z. DB `now()` 10:59:21Z.

## What was measured

Ranking a `pg_stat_statements` diff against `audit_20260830_pgss_snap` @ 09:05:42Z on
`(userid, dbid, toplevel, queryid)` **by exec time rather than by reads** put
`backfill_wmc_metadata_from_editions` on top: **71 calls / 511.9 s / 7,209 ms mean** in ~2 h.

⭐ **Ranking by reads hides it.** By reads the top row is `refresh_wmc_fmv_drift_active` (761,240
blocks). That one is **not a defect** — it is duty-cycle-limited by construction (a hard 15 s
`v_budget` per call, ~every 5 min), so its read total is a **constant, not a symptom**, exactly as the
08-30 ledger entry records. Its 16,192 ms mean *is* the 15 s budget plus the build. **A fixed-budget
job will always rank high on any cumulative axis and will never repay a lever.** Rank by exec time,
then discard anything whose runtime is a constant it was designed to spend.

## The defect

`EXPLAIN (ANALYZE, BUFFERS)` on the driving join, collection `209ade70`:

- 125 edition probes, each finding ~203 `wmc` rows and reporting **`Rows Removed by Filter: 203`** —
  every single candidate discarded.
- **23,908 buffers, 7,560 ms, rows = 0.**

The serving index `idx_wmc_coll_ek_serial_cover` (202 MB) carries none of the five filter columns, so
each of those ~25,000 rejected rows cost a heap fetch. **~1 buffer per row rejected.**

Fixed by a 2,400 kB partial index (`20260831111157`) → **459 buffers, 17.3 ms, same 0 rows.** See the
ledger entry for the full A/B, the correctness argument, and the exit condition.

## The part that is not fixed

`wmc-fmv-populate`: **1,991 runs / 24 h, 65 productive (3.3%), 6,846 rows.** Top Shot has
**~145,988 fillable rows right now**. Three of seven collections updated **zero rows across ~850
runs**. The function has **no LIMIT** — one successful call should clear the backlog. It does not.

**Do not guess.** Three lanes to close, in order:
1. Are the Top Shot calls being **cancelled** (statement timeout) and logged `ok` by the caller? — the
   18.6 s enumerate cost makes a full UPDATE plausibly timeout-bound.
2. Is the caller passing a **scoping parameter** (`p_wallet_address`) that the pipeline-level view hides?
3. Are the remaining rows NULL on the **`editions` side too**, so they qualify for the index predicate
   but not for any actual fill? (The 08-30 fix `20260830143540` added the right-hand `IS NOT NULL`
   checks precisely to exclude these — if they are still qualifying, that fix is incomplete.)

⚠ Lane 3 would mean the index is correct but the backlog is **phantom**, and the honest fix is to stop
counting those rows as fillable. Establish which lane before proposing anything.

## Instrument note

`audit_20260830_pgss_snap` has **no cron schedule** — the "2-hourly" cadence assumes every pass
snapshots by hand, and it has missed repeatedly (01:02→05:06Z and 05:06→09:05Z were both 4 h gaps).
**A snapshot was taken this pass at 11:11:22.436262Z (4,791 rows).** Scheduling it is one pg_cron line;
naming and lifecycle are Trevor's call (the table is `audit_`-named and the 08-30 entry prefers
dropping it once its owner is done). Still queued, not shipped — this is the third pass to say so.
