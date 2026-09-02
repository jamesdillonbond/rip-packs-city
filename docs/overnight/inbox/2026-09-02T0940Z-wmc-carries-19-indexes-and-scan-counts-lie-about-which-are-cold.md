# `wallet_moments_cache` carries **19 indexes / 1,924 MB against a 941 MB heap** — and the obvious way to rank them would have recommended dropping the hottest one

**Filed 2026-09-02 ~02:4x PT (09:4xZ), Claude Code cloud session. NOTHING DROPPED.**
Found while discharging the owed measurement in
[`2026-09-02T0215Z-wmc-metadata-backfill…`](2026-09-02T0215Z-wmc-metadata-backfill-is-done-and-its-partial-index-is-now-a-100pct-false-positive.md),
which twice said *"do NOT drop `idx_wmc_metadata_fillable` — its callers have not been enumerated."*
That question is now answered, and the answer is **no, obviously not** — see §2.

## 1. The footprint

| | |
|---|---:|
| `wallet_moments_cache` total relation | **2,865 MB** |
| of which INDEXES (19 of them) | **1,924 MB — 67 %** |
| live rows | 2,506,804 |
| writes recorded since stats began (81 d) | **48,421,700** ≈ **598,000/day** |

Every one of those ~598k daily writes maintains nineteen indexes. On the instance whose number-one
constraint is a 22 MB/s IO budget, index maintenance on this table is not a rounding error.

## 2. 🚨 THE TRAP, and I walked into it before catching it

The natural move is to rank by `pg_stat_user_indexes.idx_scan`, call the big low-scan ones cold, and
propose dropping them. Postgres has been up **81 days** with `stats_reset` NULL, so it is tempting to
read every counter over that window. **That reading is wrong, and wrong in the most dangerous
direction: an index's counter starts when the INDEX was created, not when statistics were.**

Dated from `supabase_migrations.schema_migrations` — the applied version IS the timestamp:

| index | size | idx_scan | created | **its own window** | **scans/day** |
|---|---:|---:|---|---:|---:|
| `idx_wmc_lock_wallet_coll_cover` | **260 MB** | 22,749 | **2026-09-02 03:50Z** | **~5.6 h** | **≈ 91,000** |
| `idx_wmc_cohort_cover` | 322 MB | 12,042 | 2026-08-06 | 27 d | **446** |
| `idx_wmc_collection_id` | 43 MB | 8,313 | 2026-08-10 | 23 d | 361 |
| `idx_wmc_lockcheck_order` | 38 MB | 2,451 | 2026-08-09 | 24 d | 102 |
| `idx_wmc_locked_count` | 5 MB | 222 | 2026-08-31 | 2 d | 111 |
| `idx_wmc_metadata_fillable` | 2.6 MB | 347,005 | 2026-08-31 | 2 d | **≈ 173,000** |

⛔ **`idx_wmc_lock_wallet_coll_cover` sits second in the naive "big and cold" list — 260 MB for 22,749
scans — and it was created FIVE AND A HALF HOURS AGO. At its own age it is one of the hottest indexes
on the table.** A drop-the-cold-ones pass run this morning would have deleted a 260 MB index shipped
that same night to fix a live starvation problem, and the scan counter would have said it was
justified.

⭐ **The transferable rule: a per-object cumulative counter is only interpretable against THAT
OBJECT'S age, never the instance's uptime.** This is the same shape as the `pipeline_runs`/
`cron.job_run_details` retention mismatch already in this repo's notes — two clocks, one window, and
the shorter one silently rescales the answer.

**And it disposes of the 0215Z filing's open question.** `idx_wmc_metadata_fillable` is **2.6 MB** and
takes **~173,000 scans/day**. It is not a drop candidate on any reading; the 0215Z advice *"do not
drop it"* was right, and the reason is stronger than "callers unenumerated" — it is emphatically
alive. ⓘ Note the arithmetic tension worth someone's attention: that filing measured
`backfill_wmc_metadata_from_editions` at **~4,000 calls/day**, and this index takes **~43× that many
scans**. Either the function issues many scans per call, or something else uses it. **Not chased.**

## 3. The one index with a structural case against it

`idx_wmc_cohort_cover` — **322 MB, 446 scans/day over a fair 27-day window**:

```
idx_wmc_cohort_cover        btree (wallet_address, collection_id) INCLUDE (fmv_usd)      322 MB
idx_wmc_wallet_coll_ek_fmv  btree (wallet_address, collection_id, edition_key)
                                                                 INCLUDE (fmv_usd)      290 MB
```

The first is a **strict column prefix of the second, with the same INCLUDE**. A btree on `(a,b,c)`
serves every access path a btree on `(a,b)` does, so the second can answer everything the first can,
including index-only scans for `sum(fmv_usd)` per `(wallet, collection)` — which is precisely the
shape `idx_wmc_cohort_cover` was built for (migration `20260806020844`,
`get_wallet_collection_stats`). `idx_wmc_wallet_coll_ek_fmv` already takes **3.9 M scans**.

**Corroborated, not merely argued:** `EXPLAIN` of that exact shape today picks
`Index Only Scan using idx_wmc_wallet_coll_ek_fmv` — the planner does not choose the narrower index
even while it exists. ⚠ **One query is not 446 scans/day.** The honest statement is that the shape it
was built for no longer uses it; what the remaining scans are has NOT been attributed.

⚠ **And a detail that reads backwards:** the two-column index is **larger** (322 MB) than the
three-column one (290 MB). Same table, and the wider key should be bigger. That is a **bloat**
signal on `idx_wmc_cohort_cover`, not a reason to keep it — but it also means a `REINDEX` is a
cheaper, fully reversible first move than a `DROP`, and it would sharpen the comparison.

## 4. ⛔ Why nothing was dropped, stated so this does not read as a queued no-op

1. **The revert is awkward on this instance.** Recreating a 2.5 M-row index needs
   `CREATE INDEX CONCURRENTLY`, which per this repo's notes is reachable ONLY via a one-statement
   pg_cron job — never `execute_sql`. A non-concurrent rebuild takes ACCESS EXCLUSIVE on one of the
   hottest tables here. So "drop it, we can always put it back" is not free.
2. **`DROP INDEX` itself takes ACCESS EXCLUSIVE** unless `CONCURRENTLY`, with the same constraint.
3. **446 scans/day is not zero, and I have not named them.** This repo's own rule is to name the
   caller before touching the object; §3 names the *original* caller and shows it has moved on, which
   is not the same thing.

## 5. What to do next, in order

1. `REINDEX INDEX CONCURRENTLY idx_wmc_cohort_cover;` — reversible, no semantic change, and it settles
   whether 322 MB is real or bloat.
2. Attribute the 446 scans/day (sample `pg_stat_statements` for queries filtering
   `wallet_address, collection_id` on this table, or watch `idx_scan` while exercising the wallet
   surfaces).
3. Only then decide the drop, via a one-statement pg_cron `DROP INDEX CONCURRENTLY`.
4. Re-run the table in §2 **using each index's own age**. Two of those six are less than three days
   old and their rates will move a lot.

## Falsifier

Re-read the §2 table in a week. **If `idx_wmc_lock_wallet_coll_cover`'s scans/day has collapsed toward
the low hundreds, it really is cold and §2's warning was about the measurement, not the index.** If it
holds near 91,000, the 260 MB is earning its keep and the naive ranking was simply wrong.
