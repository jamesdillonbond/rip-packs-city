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

## ⚠ UPDATE — the ":13 collision" is REAL but it is an INSTANCE, not the problem. The schedule is oversubscribed.

Measured every active job's real duration over 7 days. **14 jobs peak between 600 s and 966 s**, and
several of them run **hourly or every 30 minutes**:

| jobid | job | schedule | avg | max | runs 7 d |
|---|---|---|---|---|---|
| 218 | backfill-pinnacle-mint-acquisitions | `19 * * * *` | 119 s | **966 s** | 167 |
| 210 | refresh-allday-pack-sales-agg | `20 */6 * * *` | 237 s | 906 s | 28 |
| 288 | **public-board-liveness-sweep** | `28 */6 * * *` | **358 s** | 848 s | 19 |
| 215 | allday-nem-from-sales-backfill | **`*/30 * * * *`** | 190 s | 808 s | 334 |
| 236 | refresh-perfect-mint-premiums | `0 */2 * * *` | 134 s | 776 s | 94 |
| 62 | remap-misattributed-sales | `23 */6 * * *` | 205 s | 725 s | 28 |
| 75 | sync-allday-pack-dist-totals | `24 * * * *` | 49 s | 636 s | 168 |
| 235 | refresh-market-index-daily | `7 */2 * * *` | 204 s | 624 s | 94 |
| 73 | refresh-mv-pack-ev-latest | `3,33 * * * *` | 46 s | 623 s | 334 |
| 67 | allday-cross-source-sales-dedup | `40 * * * *` | 87 s | 618 s | 168 |
| 245 | refresh-pack-realized-ev | `42 * * * *` | 57 s | 616 s | 168 |
| 240 | refresh-pack-reality-stats | `30 */2 * * *` | 146 s | 608 s | 93 |
| 287 | trust-health-precompute-refresh | `58 */6 * * *` | **385 s** | 608 s | 19 |
| 217 | atlas-pack-ev | `25 * * * *` | 177 s | 606 s | 168 |

**The hourly jobs alone average ~16 minutes of heavy DB work per hour** (218+75+73×2+67+245+217
≈ 581 s, plus 215 twice an hour ≈ 380 s), before the `*/2` and `*/6` jobs. There is **no 11-minute
gap anywhere in the hour** — 85 active jobs. ⚠ **So moving one job's minute is rearranging deck
chairs**, and the earlier "two `cron.alter_job` calls" recommendation below should be read as a
small improvement, not a fix. **The schedule is oversubscribed for a 2-core / 2 GB instance**, and
the real lever is running less, not running it later.

## ⚠ THE PERMISSION DEAD END — why `cron.alter_job(71, …)` fails, and the trap in the workaround

`ERROR: XX000: Job 71 does not exist or you don't own it` is an **ownership** error, not a missing
job. Measured:

| jobid | owner (`cron.job.username`) |
|---|---|
| 71, 109 | **`cron_heavy`** |
| 235 | `postgres` |

- The MCP/dashboard connects as **`postgres`** (non-superuser). It **has EXECUTE on
  `cron.alter_job`** but does **not own** 71/109.
- `SET ROLE cron_heavy` then altering fails the other way: `ERROR: 42501: permission denied for
  function alter_job` — **`cron_heavy` owns the jobs but has no EXECUTE on `alter_job`.**
- Neither role can `UPDATE cron.job` directly (`has_table_privilege` false for both).

⚠ **DO NOT "fix" this with `cron.schedule()` using the same job name.** It would succeed — and it
would **re-own the job as `postgres`**, which silently changes its behaviour: **`cron_heavy` carries
`statement_timeout=600s`** in its `rolconfig`, which is precisely why these long jobs run as that
role. Re-owning them drops them to the default timeout and they would start being killed mid-run.

**So rescheduling 71/109 requires a superuser or the Supabase dashboard** — it cannot be done from
the MCP/SQL editor as `postgres`.

## The one change that is BOTH permitted and a real volume cut

`rpc-refresh-market-index-daily` (jobid **235**, owned by `postgres`, so alterable) is named
`_daily` and refreshes `mv_topshot_market_index_daily` **every two hours** — 94 runs/week, avg
**204 s**, max 624 s.

**The MV's own grain is daily**: its columns are `d date, tier text, sales, volume_usd, median_px,
avg_px, max_px`, and its only consumer is the public `/insights/market` board, which reads a
**~121-day daily series** (`gte("d", cutoff)`, `days` default 121). So 12 refreshes a day only ever
move **today's single partial point on a four-month daily chart**.

```sql
SELECT cron.alter_job(235, schedule => '7 */6 * * *');   -- every 2h -> every 6h
```

- **Saves ~3.7 hours of heavy DB time per week** (94 → ~28 runs × 204 s avg).
- Cost: the newest point of a **daily-grain** chart is at most 6 h behind instead of 2 h.
- **REVERT:** `SELECT cron.alter_job(235, schedule => '7 */2 * * *');`
- Deliberately changes **only the cadence, not the minute**, so the effect is attributable.

⚠ Going all the way to daily (`7 5 * * *`) would save ~4.9 h/week but leaves today's point up to 24 h
stale — that IS a product/data-freshness call. `*/6` is the version that needs no product decision.

## Also worth considering separately

`mv_topshot_market_index_daily` is named **`_daily`** but is scheduled **`7 */2 * * *` — every two
hours**, 94 runs in 7 days, averaging 198 s and peaking at 624 s. If a daily refresh is what the
data actually needs, moving it to `7 5 * * *` would remove ~90% of the single largest IO block on
the instance. **That is a product/data-freshness call, not a scheduling tweak, so it is filed rather
than proposed** — but the name and the cadence disagreeing is worth someone's attention.
