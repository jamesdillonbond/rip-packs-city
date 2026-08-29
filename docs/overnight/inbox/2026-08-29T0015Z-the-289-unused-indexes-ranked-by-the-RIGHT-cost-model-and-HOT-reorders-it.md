# The advisor's "289 unused indexes" is unactionable as stated — ranked by the RIGHT cost model it is a shortlist of ~6, and **HOT updates reorder it**

**2026-08-29 00:15Z · Claude Code · `get_advisors(performance)`, a source these notes do not routinely quote**

346 performance lints: **289 `unused_index`**, 55 `no_primary_key`, 1 `table_bloat`, 1
`auth_db_connections_absolute`. A raw count of 289 invites either a mass drop or (more likely) being
ignored. Neither is right.

## First: is the instrument even valid? (it is, and this needed checking)

⚠ **`pg_stat_database.stats_reset` is NULL, so the observation window cannot be read off it** — and
"idx_scan = 0 since a recent reset" is the classic way this advisor lies. Bounded instead by three
positive controls:

| control | value |
|---|---|
| postmaster uptime | **77 days** (since 2026-06-12) |
| total writes captured in stats | **105,638,526** |
| max `idx_scan` on any one index | **269,210,472** |

⭐ **An index reading zero against 269M scans elsewhere over 77 days is genuinely unused, not a
stats artifact.** The instrument is sound.

## Second: my own count disagreed with the advisor's, and the difference is the important part

Raw `idx_scan = 0` in `public`: **590 indexes / 380 MB** — but **309 of those are UNIQUE or PRIMARY**.
⛔ **Those are constraint-backed and must NEVER be dropped**; a low `idx_scan` on a unique index means
nobody *queried* it, not that nothing depends on it. Excluding them leaves **281**, which is where the
advisor's 289 comes from.

## 🚨 Third: ranking by total writes is WRONG, and HOT is why

My first ranking used `n_tup_ins + n_tup_upd` and put `allday_pack_sales_history` first by a mile
(11,152,376 writes, a 31 MB unused index). **That ranking is an artifact.** PostgreSQL **HOT** updates
skip index maintenance entirely when no indexed column changes:

| table | n_tup_upd | **HOT %** | index-touching writes |
|---|---:|---:|---:|
| `allday_pack_sales_history` | 11,152,245 | **89.7%** | 1,151,705 |
| `badge_editions` | 1,768,509 | **0.9%** | **1,939,539** |
| `cached_listings` | 344,007 | **0.0%** | 362,015 |
| `panini_card_serials` | 613,999 | 53.6% | 296,546 |

⭐ **`allday_pack_sales_history` does ~10× the updates but ~90% of them are HOT, so it touches indexes
LESS than `badge_editions` does.** Ranking on raw writes would have aimed the fix squarely at the wrong
table.

## The shortlist (index-touching writes × unused-index count)

| table | unused idx | size | HOT % | proxy score |
|---|---:|---|---:|---:|
| **`badge_editions`** | 2 | 1,264 kB | 0.9 | **3,879,078** |
| `allday_pack_sales_history` | 1 | **31 MB** | 89.7 | 1,151,705 |
| `cached_listings` | 3 | 432 kB | 0.0 | 1,086,045 |
| `pack_grail_metrics_mv` | 3 | 2,272 kB | — | 615,900 |
| `panini_card_serials` | 2 | 848 kB | 53.6 | 593,092 |
| `sales_2024` | 2 | 2,872 kB | 1.4 | 545,256 |

⚠ **THE SCORE IS A PROXY AND I AM NAMING ITS TWO FLAWS RATHER THAN LETTING SOMEONE INHERIT THEM.**
(1) It multiplies by index COUNT and ignores index SIZE, so it under-weights
`allday_pack_sales_history`'s single **31 MB** index against `badge_editions`' two sub-MB ones — a 31 MB
btree costs more per insert than a 656 kB one. (2) `pack_grail_metrics_mv` is a MATERIALIZED VIEW whose
"writes" are REFRESHes, a different cost model entirely (`hot_pct` is NULL for exactly that reason).
**Treat the table as a shortlist to measure, NOT as a ranking to act on in order.**

## Not shipped, and what to do instead

⛔ **Dropping an index is destructive SQL — off-limits for the autonomous pass**, and rightly so: the
`idx_scan = 0` test cannot see planner-only use, a constraint dependency, or a query that runs less often
than the stats window.
👉 **The safe sequence for whoever takes it:** confirm each candidate has no dependent constraint, then
`DROP INDEX CONCURRENTLY` **one at a time** (⚠ reachable ONLY via a one-statement pg_cron job on this
project, never `execute_sql`), and re-measure disk-read volume across the change — **and keep the DDL to
recreate each one in the same migration's revert path**, because an index is cheap to recreate and a
regression here is invisible until a page gets slow.
⛔ **Do NOT batch-drop 281 indexes.** The value is concentrated in the head of the list; the tail is
mostly small indexes on cold tables where the win is disk, not IO.

## Not established

⛔ **No BUFFERS or disk-read measurement was taken** — this is entirely `pg_stat_*` accounting, and the
IO claim is inferred, not observed. ⛔ **Nothing here says the platform's saturation is caused by unused
index maintenance**; it says there is *some* avoidable write work and where the head of it is.
