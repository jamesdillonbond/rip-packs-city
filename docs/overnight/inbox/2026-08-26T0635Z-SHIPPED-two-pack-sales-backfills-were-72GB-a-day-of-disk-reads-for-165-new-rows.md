# ⭐ SHIPPED (cadence) — two pack-sales backfills were 71.9 GB/day of disk reads and 4.55 GB/day of WAL, to add ~165 rows a day

**Filed:** 2026-08-25 ~23:35 PT (2026-08-26 06:35Z) · **By:** Claude (Cowork cloud), interactive
**Class:** R46 (the instance is disk-IO bound) · previously unfiled
**Status:** a 5x cadence cut is SHIPPED. The real fix is named, measured, and deliberately NOT shipped — §4.

## 1. How it was found, which matters more than the number

Not by looking for it. It surfaced while checking whether the 08-23 filing's *"three indexes on
an EMPTY `sales_2022` partition"* was safe to act on (it is not — see
[the PG17 filing](2026-08-26T0620Z-SHIPPED-the-pg17-index-is-repaired-and-the-shape-IS-a-decidable-rule-after-all.md) §4).
The two indexes named in that filing's judgement 2 sit on tables whose `pg_stat_user_tables` row
reads:

| table | `n_tup_ins` | `n_tup_upd` | live rows |
|---|---:|---:|---:|
| `topshot_pack_sales_history` | **3,558** | **14,903,768** | 587,037 |
| `allday_pack_sales_history` | **106** | **9,956,771** | 552,412 |

⭐ **Inserts to updates at 1 : 4,190 and 1 : 93,932.** Two tables of immutable historical
blockchain sales, being rewritten wholesale, forever.

## 2. What it costs — from `pg_stat_statements`, window 14.2027 d (reset 2026-08-12 01:34Z)

⚠ **A DATED SAMPLE. Re-derive before quoting.** ⚠ **`shared_blks_hit` is reported separately and
is NOT summed in** — cache hits are not disk IO, and conflating them is the easiest way to get
this instance's story wrong in either direction.

| statement | calls/d | **disk GB/d** | dirtied/d | WAL MB/d | s/d |
|---|---:|---:|---:|---:|---:|
| `INSERT … topshot_pack_sales_history … ON CONFLICT DO UPDATE` | 10,497 | 10.54 | 727,588 | 2,498 | 10,662 |
| `INSERT … allday_pack_sales_history … ON CONFLICT DO UPDATE` | 7,012 | 4.91 | 401,312 | 1,251 | 5,405 |
| `SELECT topshot_pack_sales_history … LIMIT $1 OFFSET $2` | 196 | **28.67** | 229,460 | 399 | 1,649 |
| `SELECT allday_pack_sales_history … LIMIT $1 OFFSET $2` | 219 | **27.76** | 216,518 | 404 | 1,906 |
| **total** | | **71.88 GB/d** | **1,574,878** | **4,552 MB** | **19,622 s (5.45 h)** |

Against a measured instance total of **~780 GB/day** of disk reads, these four are **~9.2%**.

**What that buys:** `block_time > now() - 7 days` counts **1,122** new topshot rows and **35** new
allday rows. ~165 rows/day. ⭐ **The two `LIMIT/OFFSET` SELECTs are the bigger half** — 56.4 GB/day,
at **19,183** and **16,587** disk blocks *per call*: the same "OFFSET does not paginate" defect the
[Flowty filing](2026-08-25T0620Z-every-flowty-listing-cache-holds-exactly-100-rows-because-offset-does-not-paginate.md)
found, here re-reading whole tables ~200 times a day each.

## 3. The mechanism, read from the statement rather than inferred

```sql
INSERT INTO "public"."topshot_pack_sales_history"(…12 cols…) SELECT … FROM json_to_recordset($1)
ON CONFLICT ("tx_hash","pack_nft_id") DO UPDATE SET
  "block_height" = EXCLUDED."block_height", … every column … , "tx_hash" = EXCLUDED."tx_hash"
```

PostgREST's default upsert: **no change-detection predicate.** Every re-walk of already-ingested
history rewrites every row identically — new heap tuple, three index entries, WAL — for
information that did not change.

**Callers, named from `cron.job.command`** (never inferred from the job name):
- jobid **29** `rpc-topshot-pack-sales-backfill` — was `1-58/3 * * * *`, `…/backfill-topshot-pack-sales?pages=40`
- jobid **25** `rpc-allday-pack-sales-backfill` — was `*/3 * * * *`, `…/backfill-allday-pack-sales?pages=30`

⚠ **Both edge functions have NO committed source** (deep-audit R21: 29 deployed functions have
none), which is why a full-repo grep for `pack_sales_history` returns only the *reader*
(`lib/pack-dist/fetchers.ts`) and no writer. **A grep that finds no writer is not evidence there
is none** — it is evidence the writer is outside the repo.

## 4. What shipped, and the better fix that did NOT

**SHIPPED** — `cron.alter_job`, 480 dispatches/day → 96 each:
```
jobid 25  '*/3 * * * *'    -> '0,15,30,45 * * * *'
jobid 29  '1-58/3 * * * *' -> '1,16,31,46 * * * *'
```
Offset by a minute so they do not contend for a pg_cron worker slot (`max_worker_processes = 6`
vs `cron.max_running_jobs = 32` is a live starvation source here). Recorded as
`supabase/migrations/20260826063100_audit_20260825_pack_sales_backfill_cadence_5x_cut.sql`.

**Not a freshness regression, measured:** at the moment of the change the newest row was already
**3.4 h old** (topshot) and **15.3 h old** (allday). The 3-minute cadence was not buying freshness
it was already failing to deliver.

⛔ **`suppress_redundant_updates_trigger()` was considered and DELIBERATELY NOT SHIPPED.** It is
Postgres' built-in for exactly this shape and would remove the rewrite entirely. But when it
suppresses a row the UPDATE is skipped, so that row emits **no `RETURNING` output** and
PostgREST's `page_total` falls. **An uncommitted caller that asserts on the returned count would
break silently** — and at 5 new rows/day on allday, that breakage would not be observable for
days. ⭐ **The blocker is not the trigger; it is that the caller cannot be read.** Committing
those two edge functions (R21) unblocks the real fix.

⚠ **FALSIFIER — run it, do not assume it.** Over the 24 h after this change, `n_tup_ins` should
hold its prior rate (topshot ~160/day, allday ~5/day) while `n_tup_upd` falls ~5x. **If INSERTS
fall too, the walk was covering ground and this cut is wrong — revert with
`cron.alter_job(25, schedule := '*/3 * * * *')` / `(29, '1-58/3 * * * *')`.**
ⓘ Second prediction, which tests the attribution rather than the effect: if the two `LIMIT/OFFSET`
SELECTs are issued by these same jobs, their calls/day should fall ~5x as well. If they do **not**,
they have a different caller and 56 GB/day of the total is still unattributed.

## 5. ⚠ Judgement 2 of the 08-23 filing is upheld but re-scoped

That filing proposes dropping `idx_ts_pack_sales_hist_block_time` (32 MB, 0 scans) and
`idx_allday_pack_sales_hist_pack` (31 MB, 0 scans) for write amplification. Both are still
**0 scans lifetime** on never-reset stats, so the case stands. ⛔ **Not dropped here**, because
the six-source caller rule cannot be completed: the only consumers found are
`get_pack_market_row`, `mv_topshot_pack_sales_agg` and `mv_allday_pack_sales_agg`, and the two
*writers* are outside the repo. Dropping an index whose callers cannot be enumerated is the trap
this repo keeps recording. **The cadence cut already removes ~80% of what those indexes cost.**
