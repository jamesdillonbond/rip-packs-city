# 🔴 The `net._http_response` fix treats the **17 MB heap**. The **10 GB TOAST has never been autovacuumed**, its stats are pinned at zero exactly as the heap's were, and the bloat is still growing at the pre-fix rate

**2026-09-12T09:10Z (2026-09-12 02:10 PT) · Claude Code (cloud), autonomous session.**

Register **#75** diagnosed and fixed a real defect: `net._http_response`'s `n_dead_tup` was pinned at 0, making autovacuum's trigger unreachable by construction. The fix — an hourly `ANALYZE` (pg_cron **jobid 482**) that makes the stat truthful so throttled autovacuum can act — **works, and is verified end-to-end on a scheduled cycle.**

⛔ **It is treating 0.17 % of the problem.**

## The measurement

`ANALYZE net._http_response` analyses the **heap**, which is **17 MB**. The bloat is in **`pg_toast.pg_toast_51873`**, a *separate relation* with its *own* stats and its *own* autovacuum trigger.

```sql
select c.relname, pg_size_pretty(pg_relation_size(c.oid)), s.n_live_tup, s.n_dead_tup,
       s.autovacuum_count, s.last_autovacuum, s.autoanalyze_count, s.last_vacuum
from pg_class c join pg_stat_all_tables s on s.relid = c.oid
where c.oid = (select reltoastrelid from pg_class where oid='net._http_response'::regclass);
```

| | |
|---|---|
| relation | `pg_toast_51873` |
| size | **10 GB** |
| `n_live_tup` / `n_dead_tup` | **0 / 0** — pinned at zero, exactly as the heap's were |
| `autovacuum_count` | **0** |
| `last_autovacuum` | **NULL** — it has never run, for the table's entire life |
| `last_vacuum` | 2026-09-03 (the one manual vacuum) |

⭐ **The size series proves the consequence rather than inferring it.** #75's own readings: **8,406 MB → 8,436 MB** across 09-11 23:1xZ→23:38Z. Now: **10 GB at 09:0xZ on 09-12.** That is **~1.6 GB in nine hours — the same 1.2–2 GB/day #75 recorded BEFORE the fix.** Meanwhile the heap is healthy: `n_dead_tup` **29**, `last_autovacuum` 2026-09-12 08:41Z. **The loop does exactly what it was verified to do, and the file keeps extending.**

⭐ **And the ratio is worse than #75's opening figure of 443 MB in 8.4 GB:** **10,524 live rows holding 418 MB of `content`** (avg 41 kB, max 669 kB; the 6-hour TTL window is honest — oldest 02:59Z, newest 08:59Z) **inside a 10 GB TOAST ≈ 96 % dead space.**

## ⛔ What I deliberately did NOT do

**`pgstattuple` is installed**, and running it would give an exact reclaimable figure. ⛔ **Not run:** a full scan of a 10 GB relation against the Small tier's **22 MB/s** budget is **~7.5 minutes of the entire instance's IO**, which would manufacture the very saturation spell **M11** counts — and it would refine, by a few points, a ratio already obtainable for free from live content vs relation size. **A cheap sample beat the good story.**

## ⭐ A lever #75 did not consider, stated so it can be judged rather than rediscovered

A plain **`VACUUM` on the parent DOES process its TOAST table**. #75 measured a manual VACUUM as unthrottled (>60 s, drove `io_waiters` 0–2 → 6, had to be `pg_cancel_backend`'d) and concluded *"do NOT schedule a manual VACUUM here"*.

⚠ **That conclusion rests on a default, not a constraint.** A manual VACUUM is unthrottled because `vacuum_cost_delay` defaults to **0** for manual vacuums — autovacuum's own 2 ms delay is what makes it safe. A scheduled `SET vacuum_cost_delay = 2; VACUUM net._http_response;` is throttled **the same way autovacuum is**, and is the only thing available that stops the ~1.6 GB/9 h accrual without taking a lock.

⛔ **NOT SHIPPED, and the reasons are cumulative rather than timid:**
1. the previous manual VACUUM here had to be **cancelled** for measured IO harm — the throttling argument is sound but untested *on this table*;
2. the estate is in a **four-day M11 saturation-spell run** (09-09 135 · 09-10 63 · 09-11 **203** · 09-12 58 so far), which is the worst possible week to add IO to the #1 physical reader;
3. **it would not reclaim the existing 10 GB anyway** — only `VACUUM FULL` does, that takes ACCESS EXCLUSIVE and blocks every pg_net lane, and #75 already records it as Trevor's.

**So both halves belong in one maintenance-window decision, not one shipped at 2 a.m.**

## ⚠ Measured vs inferred, kept separate

- **Measured:** the toast relation's zeroed stats and never-run autovacuum; the 10 GB size; the 418 MB of live content; the growth across #75's own earlier readings; the heap's healthy counters.
- **Inferred from standard Postgres behaviour:** that autovacuum evaluates a TOAST table independently on its own stats, and that a parent `VACUUM` processes the TOAST. Both are documented behaviour, neither was verified on this instance.

## Re-check conditions

- **Is the growth stopped?** `pg_relation_size('pg_toast.pg_toast_51873')` against the 10 GB here. Flat for 24 h = fixed; another ~1.6 GB/9 h = unchanged.
- **Did autovacuum ever reach it?** `autovacuum_count` on the toast relid moving off **0**.
- ⚠ **Do not score this from the heap's counters.** They are healthy and have been since #75 shipped; that is precisely what made this invisible.

## ⭐ PROMOTE

**A stats-collector defect on a heap does NOT imply its TOAST was fixed with it.** They are separate relations with separate triggers and separate stats — and **the bloat is usually in the one nobody names**, because every query, every `\dt`, and every monitoring view reports the heap.
