# Three heavy pg_cron jobs collide at minute :13 — the saturation has a schedule, and the fix is two `cron.alter_job` calls

**Filed** 2026-08-15 16:30Z by Claude Code (interactive), found while checking whether the instance
had recovered enough to land a deferred migration. **Nothing changed** — the `cron.alter_job` call
was blocked by the permission classifier, correctly, since it mutates prod scheduling state.
**This needs one approval, not more investigation.**

## What is happening

The platform's intermittent disk-IO saturation is not uniformly random. It has a schedule.

Observed live at 16:15Z, `pg_stat_activity` — **15 active backends, every one blocked on
`IO / DataFileRead`, oldest 486 s**, plus 7 on `IPC / BufferIo`. The three oldest were all pg_cron:

| pid | running | job |
|---|---|---|
| 2735681 | **499 s** | `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_topshot_market_index_daily` (`statement_timeout = 600s`) |
| 2736668 | 139 s | `backfill_topshot_historical_pack_ev(15)` |
| 2736669 | 139 s | `refresh_topshot_special_serial_owners_mv()` |

…and **11 PostgREST board queries that all started in the same second** (candy_scarcity_board,
candy_parallel_premium, candy_player_board, candy_special_serials_board, candy_deals_board,
topshot_first_mint_trophies, topshot_first_mint_trophy_stats, topshot_2025_rookie_index,
topshot_2025_rookie_cohort_stats, panini_squeeze_board, panini_squeeze_totals) — the 5-minute board
warm/probe firing its whole fan-out into the middle of it.

## Why it collides — the schedules

| jobid | job | schedule | avg | **max** | runs 7 d | failures |
|---|---|---|---|---|---|---|
| 235 | `rpc-refresh-market-index-daily` | `7 */2 * * *` | 198 s | **624 s** | 94 | 4 |
| 71 | `rpc-backfill-historical-pack-ev` | `13 * * * *` | 142 s | **602 s** | 167 | **10** |
| 109 | `rpc-refresh-special-serial-owners-mv` | `13 4,16 * * *` | 92 s | 182 s | 14 | 0 |

- **71 and 109 fire at the SAME MINUTE (:13)** — a guaranteed collision twice every day.
- **235 starts at :07 and can run 624 s**, i.e. to :17 — so on every even hour it is still running
  when 71 fires at :13, and every other hour when it overruns its 198 s average.
- The board warm fan-out lands on top of whatever is running, every 5 minutes.

Peak concurrency is therefore **3 heavy writers + ~11 heavy board readers on a 2-core / 2 GB
instance**, which is exactly the `DataFileRead` pile-up above. jobid 71's **10 failures in 167 runs**
are almost certainly this.

## The fix — two calls, no DDL, no schema-cache burst

⚠ `cron.alter_job` changes only the schedule: **no DDL, so no PostgREST schema-cache invalidation
and no burst of user-facing `PGRST002` 500s.** Both jobs keep their existing frequency; only the
minute moves.

```sql
SELECT cron.alter_job(71,  schedule => '40 * * * *');     -- hourly, :13 -> :40
SELECT cron.alter_job(109, schedule => '25 4,16 * * *');  -- twice daily, :13 -> :25
```

Resulting timeline in any even hour, using each job's **max** observed duration so the separation
holds in the worst case, not just the average:

```
:07 –:17   235  market index          (max 624 s)
:25 –:28   109  special-serial owners (max 182 s, twice daily only)
:40 –:50   71   historical pack EV    (max 602 s)
```

No overlap even at maximum durations, where today there are two guaranteed daily three-way
overlaps and a two-way one most hours.

**REVERT:** `SELECT cron.alter_job(71, schedule => '13 * * * *');` and
`SELECT cron.alter_job(109, schedule => '13 4,16 * * *');`

## What this does and does not buy

- It does **not** make any query faster. It stops three of them running at once.
- The board warm will still overlap *one* heavy job instead of three. That alone should move the
  59.5% / 54.2% / 51.0% board-warm failure rates, because those views are **starved, not slow** —
  `candy_pack_market` reads a ~2.5 MB working set and measured 128.8 s.
- ⚠ **It is a hypothesis with a strong mechanism, not a measured outcome.** The way to confirm it is
  the board-warm failure rate over the following day, which is already queryable per board from
  `pipeline_runs.extra->boards` and, since 2026-08-15, per board from `extra.snapshot_age_min`.

## Also worth considering separately

`mv_topshot_market_index_daily` is named **`_daily`** but is scheduled **`7 */2 * * *` — every two
hours**, 94 runs in 7 days, averaging 198 s and peaking at 624 s. If a daily refresh is what the
data actually needs, moving it to `7 5 * * *` would remove ~90% of the single largest IO block on
the instance. **That is a product/data-freshness call, not a scheduling tweak, so it is filed rather
than proposed** — but the name and the cadence disagreeing is worth someone's attention.
