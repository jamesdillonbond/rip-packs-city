# The quiet-window ranking that found a 36 % consumer — and the control that refuted #84's culprit

**2026-09-12 ~08:00 PT · Claude Code (cloud), autonomous session · SHIPPED half is in the ledger and register #85; the refutation half is appended to #84.**

---

## 1. The method, which is the reusable part

Every previous pass at the saturation spells ranked jobs by what they were doing **during** a spell. That cannot work: in a spell every job's busy-seconds rise, so the ranking measures the spell. ⭐ **Rank them in the UNCONTENDED window instead, where nothing is queuing behind anything.**

```sql
with w as (
  select jobid,
         case when start_time >= timestamptz '2026-09-12 07:00Z' and start_time < timestamptz '2026-09-12 13:00Z' then 'spell'
              when start_time >= timestamptz '2026-09-12 02:00Z' and start_time < timestamptz '2026-09-12 06:00Z' then 'quiet' end as win,
         extract(epoch from (coalesce(end_time, now()) - start_time)) as secs
  from cron.job_run_details where start_time >= timestamptz '2026-09-12 02:00Z'
)
select j.jobid, j.jobname, j.schedule,
       round(sum(secs) filter (where win='quiet')/4.0, 1) as quiet_busy_s_per_h,
       round(sum(secs) filter (where win='spell')/6.0, 1) as spell_busy_s_per_h
from w join cron.job j using (jobid) where win is not null
group by 1,2,3 order by quiet_busy_s_per_h desc nulls last;
```

**Fleet totals: 1,857 busy-seconds per hour quiet → 11,464 in the spell, across 117 jobs.** The box is 2-core, so 7,200 s/h is the ceiling: the spell window is ~1.6x oversubscribed, which is what queueing looks like from the scheduler's side.

**Top of the QUIET ranking** (the column that is not contaminated):

| jobid | job | schedule | quiet s/h | spell s/h |
|---|---|---|---:|---:|
| 466 | `rpc-ts-listings-atlas-sync` | `*/2` | **666.4** | 3,002.6 |
| 464 | `rpc-allday-unmapped-atlas-resolver` | `4-59/5` | 348.7 | 1,003.5 |
| 303 | `rpc-refresh-wmc-fmv-changed` | `7-57/10` | 217.8 | 640.0 |
| 463 | `rpc-atlas-market-drain` | `1-59/2` | 107.0 | 1,094.7 |
| 486 | `rpc-wmc-fmv-populate-backstop` | `4,24,44` | 63.3 | 127.7 |
| 449 | `rpc-atlas-editions-drain` | `1-59/2` | 21.1 | 311.5 |
| 469 | `rpc-topshot-moments-hydrate-chain` | `3-59/4` | 19.8 | 352.8 |
| 355 | `rpc-backfill-pinnacle-trade-acquisitions` | `23 1-22/3` | **2.0** | 115.0 |

⭐ **jobid 466 alone is 36 % of the estate's quiet-window database work.** And **jobid 355 — the culprit #84 names — is 2.0 s/h quiet and 115.0 s/h in the spell, a 58x ratio on work this file's own measurement calls constant.** A job whose cost is ~0 when the box is idle is not what makes the box busy.

---

## 2. What jobid 466 turned out to be — SHIPPED

`atlas_listing_verify_dispatch` grouped and sorted **261,531 nft_ids every two minutes to return TWO.** `EXPLAIN (ANALYZE, BUFFERS)`, back to back, same warm cache: **57,176 buffers + temp read 838 / written 1,570 (5 batches, 7,624 kB to disk), 264,187 rows, 424 ms → 54 buffers, no temp, 500 rows, 2.2 ms. 1,059x.** Live: seven consecutive ticks failing at exactly 120.0 s, then 11.7 s / 3.1 s / 3.7 s, all succeeded.

⚠ **It did not end the spell.** The next ticks ran 20.7 s and 41.7 s and `pg_stat_activity` twelve minutes later still showed 13 active backends in IO wait — with `refresh_wmc_fmv_changed(30, 200000)` now the oldest. Full detail: ledger 2026-09-12, register **#85**, migration `20260912143408`.

---

## 3. The control that refutes #84's "fresh corroboration"

#84 argues 355 is a real cause from one day: *355 fires 07:23:03Z, runs 601.8 s, estate-wide burst at 07:25.* Two things that paragraph does not have:

- **What was already failing on 09-12.** Ordered by first failure: **212 and 466 at 06:50:00Z**, 464 at 06:59, 463 at 07:21, **then 384 and 355 at 07:23:03**. jobid 466 failed on **every tick** from 06:50 to 07:14 — thirteen consecutive `statement timeout`s at exactly 120.0 s. **355 joined a spell that was 33 minutes old.**
- **A second day.** On **09-11** the first failure is **466 at 07:28:00Z**, and **355 ran at 07:23:00 and SUCCEEDED in 9.8 s** — healthy, five minutes before the spell began.

**355's duration read as a distribution rather than as a maximum:** 09-11 01:23 **8.6 s** · 04:23 **7.7 s** · 07:23 **9.8 s** · 10:23 79.5 · 13:23 **570.8** · 16:23 115.8 · 19:23 157.3 · 22:23 **9.0**; 09-12 01:23 **9.2** · 04:23 **8.0** · 07:23 **601.8** · 10:23 88.3. ⭐ **8–10 s whenever the instance is idle, 80–600 s whenever it is not, on constant work. That is a thermometer.**

⚠ **The lesson is about where the control went missing.** This repo's rule is *"a POSITIVE needs a no-change control the fix cannot move"*. The 09-12 sequence was a positive with no control, and the control was **one query away — the same job, the previous day**. ⭐ **A "fresh corroboration" appended to an existing item is exactly where controls get skipped, because the item already has a conclusion and the new reading is only being asked whether it agrees.**

⛔ **What this does NOT establish.** 355 is not cleared as an *amplifier*, and the batch-size lever is still worth taking on its own merits — as mitigation, not as removing the cause. **The trigger is still unidentified.** What is now known: the earliest failing job on both days is 466 (fixed), the step change in fleet health dates to **2026-09-09** (jobid 212 `rpc-refresh-topshot-pack-sales-agg` ran **10–18 s at all four daily slots on 09-05→09-08** and **100–617 s from 09-09**), and 212 itself is a 309 MB `REFRESH MATERIALIZED VIEW CONCURRENTLY` whose 14-second healthy time is exactly 309 MB at the tier's 22 MB/s floor — **another thermometer, not a trigger.** What landed on 09-09 is the open question.

---

## 4. Still open, in priority order

1. **What changed on 2026-09-09.** Four migrations that day; the `sales` per-partition unique indexes (#68) and the Atlas sales recovery (#67) are the two that touched hot data. Not measured.
2. **`refresh_wmc_fmv_changed`** — 1,826 GB of disk reads and **208 exec-hours in 31 days** from 4,211 calls, the single biggest line in `pg_stat_statements`. ⛔ **Deliberately NOT touched:** it is a deadline-bounded drain that is *designed* to consume its budget, it is pinned, it is FMV-correctness-critical, and it has already had several measured optimisation passes documented in its own body. **Its cost is its upstream's over-production (`fmv-recalc` writes a snapshot per recalculated edition whether or not the number moved — 74 % identical, measured 08-30), which CLAUDE.md already records as sized-and-known.** The lever is upstream.
3. **The two telemetry `count(*)`s in `sync_ts_listings_from_atlas`** — same 264 K population, every 2 minutes, 68 of 464 timeouts. Pinned as an honesty invariant (*"counted, never guessed"*), so the fix must make them cheap, not absent.
4. **#35's OFFSET pagination pair** (`topshot_pack_sales_history` 507 GB, `allday_pack_sales_history` 500 GB in 31 days) is still 1 TB/month. ⛔ Its recorded blocker — the two writers are edge functions with no committed source — was **not** worked around here: reading them back needs `get_edge_function`, which CLAUDE.md records as having burned a live gate key into a transcript twice. **That is an operator step, not a sandbox one.**

---

## 5. Addendum — where the disk IO actually goes, and it is three tables holding 5.7 GB

The section above ranks **jobs**. This ranks **tables**, from `pg_statio_user_tables`, and it reframes everything above it.

⚠ **Window caveat first, because it changes how these may be quoted.** `pg_stat_database.stats_reset` is **NULL** on this instance, so these counters have no known start — they are NOT the 31-day `pg_stat_statements` window (24,820 GB) but a longer one (34,824 GB database-wide). **Quote the SHARES, which are window-independent if the mix is stable; do not quote the absolute GB as a rate.**

| table | on disk | disk reads | share of all user-table reads |
|---|---:|---:|---:|
| **`wallet_moments_cache`** | 3,292 MB | 11,401 GB | **33.0 %** |
| **`fmv_snapshots_2026`** | 950 MB | 4,817 GB | **13.9 %** |
| **`sales_2026`** | 1,419 MB | 4,425 GB | **12.8 %** |
| `_http_response` | 11 GB | 1,493 GB | 4.3 % |
| `panini_card_serials` | 186 MB | 1,030 GB | 3.0 % |
| `sales_2023` | 838 MB | 992 GB | 2.9 % |
| `topshot_pack_sales_history` | 309 MB | 921 GB | 2.7 % |
| `topshot_atlas_market_events` | 784 MB | 892 GB | 2.6 % |

⭐⭐ **The top three are 59.7 % of all disk reads and hold 5.7 GB between them.** `wallet_moments_cache` alone is read ~3,450 times over. ⭐ **And the three are one chain: `sales` → `fmv_snapshots` → `wallet_moments_cache`. The FMV recompute path is roughly sixty per cent of this database's disk IO.** CLAUDE.md already says *"fmv-recalc — wasteful, NOT broken, SIZED (it owns the DB's #1 reader)"*; this quantifies it and adds the #2 and #3, which were never named.

⚠ **Everything else is a long tail** — no fourth item reaches 5 %. **A saturation fix that does not touch the FMV chain is trimming 40 % of the problem**, which is the honest frame for the jobid-466 change shipped today (`topshot_atlas_market_events`, 2.6 %, and only part of that).

⛔ **NOT ACTED ON, and the reasons are specific rather than cautious:**
- **`refresh_wmc_fmv_changed` is the biggest statement** (1,826 GB / **208 exec-hours** / 4,211 calls in 31 days) and writes `wallet_moments_cache`. It is a **deadline-bounded drain designed to consume its budget**, it is pinned, it is FMV-correctness-critical, and its body already carries several measured optimisation passes. **Its cost is its upstream's over-production**, which the body itself records: *74 % of new snapshots carry an `fmv_usd` IDENTICAL to the edition's previous one*, because `fmv-recalc` writes a row per recalculated edition whether or not the number moved. **The lever is upstream, and it is Trevor's per CLAUDE.md.**
- **Its own comment names a bloated index** — *"a 2.5M-row table behind a bloated `(collection_id, edition_key)` index"* — and `REINDEX CONCURRENTLY` was considered and **not run**: `wallet_moments_cache` carries **19 indexes totalling ~2.3 GB**, a reindex of the 372 MB candidate is a full rebuild's worth of IO **in the middle of a live spell**, and bloat was not measured, only quoted from a comment. **Re-measure the bloat in the quiet window (02:00–06:00Z) and reindex there, not at 8 a.m.**
- **Three indexes are being FULL-SCANNED, which is the one unexplored lead here**: `idx_wmc_cohort_cover` (340 MB, **13,157 scans, 636 GB read — 48 MB per scan**), `idx_wmc_lockcheck_order` (39 MB, 4,563 scans, 113 GB — 24 MB/scan), `idx_wmc_collection_id` (43 MB, 10,511 scans, 111 GB — 10.5 MB/scan). **860 GB combined, from three indexes read end-to-end rather than sought into.** By contrast `idx_wmc_moment_collection_cover` does 314 M scans for 840 GB — 2.7 KB per scan, a healthy point lookup. ⚠ **Which statements drive the three full scans was NOT established** — `pg_stat_statements` does not attribute per index, so this needs `auto_explain` or a live `pg_stat_activity` catch, and naming a query without that would be a guess.

---

## 6. Addendum — `job startup timeout` is not what #73, #84 and M11 all think it is

The three items share one mechanism: heavy jobs overlap and **exhaust `max_worker_processes = 6`**, so everything else fails to launch. It is refuted on three independent grounds, and the third is a control.

1. **`cron.use_background_workers = off`.** pg_cron here launches jobs as **client sessions over libpq**, not background workers, so those six slots are not on the path. The cap that applies is `cron.max_running_jobs` = **32**.
2. **Observed concurrency reaches 15.** Running sum over `cron.job_run_details` start/end events, 36 h: concurrency 7 occurs at 1,762 transitions, 8 at 1,016, 10 at 242, 15 at 3. **A cap of 6 crossed 1,762 times is not a cap.**
3. ⭐⭐ **Identical concurrency, 114 timeouts vs 0.** `09-12 13:00Z` max concurrency **11**, mean **4.4** → **114** startup timeouts. `09-12 14:00Z` max **11**, mean **4.4** → **0**. And the window's *highest* concurrency, **15** at 09-11 12:00Z, produced only **17**. **Concurrency is not the variable.**

⚠ **Connection exhaustion is excluded separately**, so this is not "sessions instead of workers, same story": `postgres_logs` over 07:00–08:00Z contains **no `too many clients already`, no `could not fork`** — only the `cron job <id> job startup timeout` lines.

✅ **What replaces it: a severity marker, with a threshold.** Against statement timeouts per hour — the direct IO-pressure measure — every hour at **≥45** carries a startup-timeout burst (09-11 13Z 50→86 · 09-11 18Z 50→63 · 09-12 07Z 47→58 · 09-12 12Z 47→191 · 09-12 13Z 45→114) and every hour at **≤43** carries few or none (09-12 14Z 22→0 · 09-12 09Z 24→0 · 09-11 20Z 33→0). ⚠ **The mechanism — a new backend's startup exceeding pg_cron's connect deadline under IO saturation — is the remaining HYPOTHESIS, not a measurement.** It fits the timing, the estate-wide simultaneity and the absence of any connection-limit error, and it has not been proven from inside.

🚨 **Why this matters more than tidiness: M11 counts this metric, and it is a cliff function.** It reads exactly zero while pressure climbs, then explodes — *"09-03→09-08 all ZERO, then 09-09: 135"* is that shape, not a sudden onset. **A gate that is 0 until it is 135 cannot steer, and its zeros are not evidence of health.** A continuous instrument (statement timeouts/hour, fleet median duration) would have shown the ramp. Changing a gate's metric is Trevor's call.

⛔ **The practical saving: "de-cluster the six-hourly MV refreshes" follows directly from the six-slot mechanism and would not have worked.** Anyone reading #73 before today would have reached for it.
