# The read path, attributed: 15 RPCs are 93 hours of DB time in 11 days — and 0.9% of the calls are 14.6% of it

**Filed 2026-08-23 15:35 PT (22:35Z) by Claude (Cowork, cloud). Measured, NOTHING SHIPPED.**
Saturation control taken first: `io_wait 9 / active 15 / total 44` — the 21:10Z spell (34/32/43) had
eased, so these are quiet-window reads. `pg_stat_statements` since **2026-08-12 01:33Z** (11.4 days),
`track = top`, **`dealloc = 4`** — the hash has evicted, so **absence from this table is not proof of
absence**; every figure below is a floor.

## Why this exists

The [R46 brief](2026-08-23T1610Z-R46-is-a-working-set-problem-not-an-IOPS-one-and-the-first-lever-may-be-free.md)
settled the shape: a **6.5 GB hot set against 512 MB `shared_buffers`**, **765 GB/day** read against a
13.5 GB database — the same data re-read ~57×/day because it cannot stay resident. It also settled
that **query optimisation is not the lever**, tested rather than assumed (`/api/ready` still 504'd
after its work was cut ~330×).

**I am not re-deriving either, and I am not proposing a query rewrite.** What the brief has is the
aggregate. What it does not have is *which callers constitute it*. That is this filing.

## The attribution

Top 15 by total execution time, PostgREST `rpc/` entry points, 11.4 days:

| function | calls | mean ms | max ms | total | blks/call |
|---|---:|---:|---:|---:|---:|
| `get_edition_recent_sales` | 128,468 | 596 | 8,000 | **21.3 h** | 54 |
| `get_edition_market_bundle` | 63,655 | 531 | 7,998 | 9.4 h | 341 |
| `get_edition_special_serials` | 74,962 | 365 | 7,989 | 7.6 h | 26 |
| **`get_topshot_sniper_deals`** | **2,989** | **9,054** | 29,987 | **7.5 h** | **1,931** |
| **`get_topshot_pool_backfill_targets`** | **1,915** | **11,510** | 29,805 | **6.1 h** | **1,657** |
| `get_pack_ev_contributors` | 5,592 | 3,759 | 29,889 | 5.8 h | 291 |
| `get_pack_lifecycle_row` | 4,749 | 4,359 | 29,949 | 5.8 h | 640 |
| `get_player_top_sales` | 10,066 | 1,855 | 7,997 | 5.2 h | 296 |
| `get_pack_market_row` | 10,987 | 1,523 | 29,490 | 4.6 h | 240 |
| `get_set_detail` | 7,565 | 1,925 | 13,167 | 4.0 h | 101 |
| `get_edition_in_packs` | 65,193 | 213 | 4,934 | 3.9 h | 14 |
| `get_edition_insight_links` | 38,361 | 335 | 7,940 | 3.6 h | 22 |
| `get_set_editions` | 6,332 | 1,812 | 7,990 | 3.2 h | 103 |
| `get_edition_high_offer` | 9,863 | 1,064 | 29,845 | 2.9 h | 610 |
| `get_pack_sales_history` | 11,578 | 839 | 28,968 | 2.7 h | 46 |

**≈93 hours of execution in 274 hours of wall clock — a 34% duty cycle from these fifteen alone**,
consistent with the brief's "≈4.5 backends busy at all times".

💡 **`max_exec_time` is a ceiling, not a measurement.** The values cluster at **~7,990** and **~29,950**
— those are the `authenticated` (8 s) and `service_role` (30 s) role statement timeouts. Every row
near them is being *killed*, not completing. That is the same population the Vercel logs show
"degrading to empty" on `/[collection]/edition/[slug]`.

## The part that is new: cost is not where call volume is

Two functions are **0.9% of the calls in this table and 14.6% of the time**:

| | calls | share of calls | total | share of time | blks/call |
|---|---:|---:|---:|---:|---:|
| `get_topshot_sniper_deals` + `get_topshot_pool_backfill_targets` | 4,904 | **0.9%** | **13.6 h** | **14.6%** | ~1,800 |
| the other thirteen | 457,371 | 99.1% | 79.4 h | 85.4% | ~90 |

Each of those two reads **~13–15 MB per call**. In a system whose diagnosed problem is *a working set
that will not stay resident*, a caller that sweeps 13 MB per invocation is not merely slow — it is an
eviction engine. This is the one lever the R46 finding does **not** rule out: it is not query
optimisation, it is **less re-reading of the same 6.5 GB**.

## ⚠ Before anyone acts on that: name the caller, and the second one is INVISIBLE

`get_topshot_pool_backfill_targets` — caller named with a positive control, not inferred:
**pg_cron jobid 16 `rpc-backfill-pack-pool`**, schedule `3,8,13,…,58 * * * *` — **every 5 minutes**,
`postgres`-owned → edge function `supabase/functions/backfill-topshot-pack-supply/index.ts` (repo
grep) → the RPC. 24 h of `cron.job_run_details`: **267 succeeded (avg 0.2 s) · 20 failed (avg 22.7 s,
453 s)**. The 0.2 s successes are `net.http_get` *dispatch*, not outcome.

🚨 **`backfill-topshot-pack-supply` writes NO `pipeline_runs` row at all** — a query across
`pipeline_runs_daily` for every `%pack-pool%` / `%pack-supply%` / `%pool-backfill%` name returns `[]`.
So this job's **work-per-outcome cannot be read from the pipeline board**. It has been dispatching
288×/day and nobody can say whether it has written a row this month.

⛔ **That is why I am not proposing a cadence cut.** The register's own rule is *failure rate is not
waste; work-per-outcome is* — and the work half is unmeasurable here. Cutting the cadence of a backfill
that is genuinely progressing would be the mirror of the `skipped_permanent` error I made on
`allday-pack-opens-backfill` this morning: acting on an inferred mechanism against position state.
**The prerequisite is a `log_pipeline_run` call in that edge function** (one line, shippable via MCP by
whoever has the function's source in hand). Then one week of rows decides the cadence question on
evidence.

`get_topshot_sniper_deals` is the Pro sniper feed — a real user surface at 2,989 calls, so its cost is
bought, not wasted. Recorded for the ranking, not proposed for change.

## Two severity corrections to same-day filings

**1. `apply-fmv-haircut` is NOT an FMV-staleness incident.** The [21:10Z monitor](2026-08-23T2110Z-daytime-monitor-spell-deepened-and-apply-fmv-haircut-missed-a-full-daily-cycle.md)
correctly flagged a missed daily cycle and correctly asked for the `_haircut` stamp check. I ran it:

| collection | `1.7.0_haircut` rows, 14 d | freshest stamp (PT) |
|---|---:|---|
| `nba_top_shot` | 11,405 | **08-23 14:55** — minutes old |
| `nfl_all_day` | 5,450 | 08-23 14:55 |
| `laliga_golazos` | 785 | 08-22 18:10 |

And `v_rpc_trust_health`: `topshot_fmv_stale_hours` **0.1** (breach 6) · `topshot_fmv_pct_stale_30d`
**0.0** (breach 50) · `fmv_sanity_flags` **0** · every collection's FMV arm `ok`.
**The haircut is applied continuously by `/api/fmv-recalc`'s per-collection inline clamp; the daily
sweep is a catch-up, not the primary writer.** Its Top Shot leg has failed every run since the 08-16
per-collection split (`nba_top_shot: upstream request timeout` on 08-18, 08-20, 08-21, 08-22), which
is worth fixing — but it is **medium, not an accuracy breach**, and no FMV shown to a user is stale
because of it. ⚠ I nearly filed the opposite before measuring.

**2. `sync-nba-projections` is off-season, not broken.** 187 runs / 26 days, **`rows_written = 0` on
every single day including the 48 that reported `ok`**, and `all_upstreams_failed` since 08-05.
`nba_player_projections`: 485 rows, `last_synced_at` **2026-07-20**, latest `game_date` **2026-07-20**,
**0 future games**, sources `draftkings` + `espn-team-leader`. There is no NBA slate in August; the
upstreams correctly have nothing. **The defect is the classification, not the pipeline** — a no-slate
condition should log `ok:true, skipped:'no_slate'`, not `ok:false`. As written it contributes 5–8
failures a day to the board, and it will still be crying wolf in late October when the season resumes
and a genuine break would look identical. Route-code fix → handoff.

## What I did NOT do, and why

- **No query rewrite, no index.** R46 tested that lever and it did not survive a spell. Re-deriving it
  is what §3.1 of the pass skill exists to prevent.
- **No cadence change to jobid 16.** Unmeasurable outcome; see above.
- **Nothing to `promote_unmapped_sales`.** The [12:30 PT filing](2026-08-23T1930Z-promote-unmapped-sales-burns-1598s-a-week-on-two-collections-that-promote-nothing.md)
  proposed "stop scheduling the UFC and Golazos legs — zero code". ⚠ **That mechanism does not exist as
  described**: only **one** pg_cron job calls `promote_unmapped_sales` (jobid 215, scoped to AllDay —
  the collection doing real work). The UFC and Golazos calls are **tail-calls inside route handlers**
  (`app/api/cron/ufc-sales-history-backfill`, `golazos-sales-history-backfill`,
  `golazos-discover-buyers` — repo grep), so removing them is route code, not a cron edit, and turning
  off those crons would stop the backfills too. My own 24 h re-measure: `nfl_all_day` 259 runs /
  28.2 s avg / **266 rows**; `laliga_golazos` 109 / 1.41 s / **0 rows**; `ufc_strike` 41 / 7.9 s /
  **0 rows** → **478 s/day** of zero-yield work, higher than the filing's 1,598 s/week. The conclusion
  stands; the proposed mechanism does not.

## Owed, in priority order

1. **Make `backfill-topshot-pack-supply` observable** (one `log_pipeline_run` call). Unblocks a 6.1 h /
   11 d decision. Edge function → MCP-shippable by a session with the source.
2. **`apply-fmv-haircut`'s `nba_top_shot` leg** — the 08-16 split rescued six collections and left the
   largest one still exceeding its per-leg upstream budget on every run.
3. **`sync-nba-projections` no-slate classification** — before the season restarts.
4. **`promote_unmapped_sales`** UFC/Golazos tail-calls — route code, ~478 s/day.

Nothing here is a security or accuracy breach. Security invariants and every FMV arm are `ok`.
