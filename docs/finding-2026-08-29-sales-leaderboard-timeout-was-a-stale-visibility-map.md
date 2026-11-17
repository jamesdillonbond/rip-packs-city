# `/api/analytics/sales/leaderboard` — the 77% failure rate was a stale visibility map

**Measured 2026-08-29 00:00–00:35Z (2026-08-28 17:00–17:35 PT), Claude Code on Trevor's box.**
**Status: FIXED and verified in production.** The route was failing 20 of 26 requests; the same
10-request sweep now returns 10/10.

This resolves the open fork left by the 23:00Z Cowork pass, which had correctly refuted the
attractive fix and handed over one decisive read. The answer turned out to be neither branch it
named — not a missing index, and not a materialisation/design change.

---

## What the Cowork pass established, and what it left open

Its finding stands in full and is worth keeping:

- 24 h: 6× 200 / 20× 500 = **76.9% failure**; last 6 h: **0 / 10**.
- Every 500 is `rpc_error canceling statement due to statement timeout`.
- `analytics_sales_leaderboard` in `pg_stat_statements`: 32 calls, **mean 16,998 ms**, max 29,020 ms.
- ⛔ The `prior_addrs` → correlated-`EXISTS` rewrite is **refuted**: worth ~2.5 s of 16.3 s. Do not
  re-propose it. That refutation is confirmed here — `prior_addrs` does not appear in the plan's
  cost at all for the `l30` payload.
- ✅ The 2026-08-13 hardening holds: both legs must succeed, so users saw *"Couldn't load this
  leaderboard"* rather than a fabricated empty board. Degraded, not lying.

Its stated next step was: `EXPLAIN (ANALYZE, BUFFERS)` the `window_sales`+`agg` leg and read
`pg_get_viewdef('analytics_sales')`, to separate *"missing index on `sold_at`/`collection`"*
(cheap) from *"the view's derivation"* (a design change, Trevor's call).

**Both branches are wrong.** The plan was already using a covering index, and the view's
derivation is not the cost either.

---

## The measurement

`EXPLAIN (ANALYZE, BUFFERS)` on the production payload (`role=seller, window=l30,
collections=topshot, min_volume=100, limit=10`) showed a **Parallel Index Only Scan** on
`idx_sales_2026_pulse_window` — the right index, already covering — carrying:

```
Heap Fetches: 66218
Buffers: shared hit=52623 read=22111
```

An Index Only Scan performs a heap fetch only for pages the **visibility map** does not mark
all-visible. 66,218 of them means the VM over the recent slice of `sales_2026` was stale.

⭐ **The discriminator — same index, same query shape, near-identical row count, different age:**

| `sold_at` window | rows | buffers | heap fetches | elapsed |
|---|---:|---:|---:|---:|
| 60–90 days ago (stable) | 115,200 | **15,089** | **10,616** | **716 ms** |
| last 30 days (hot) | 117,076 | **74,754** | **66,218** | 4,970–9,530 ms |

Same number of rows, 5× the buffers, entirely attributable to heap fetches. The recent window is
a dirty region; age is the only variable.

⚠ **Two consecutive runs of the identical query read the identical 74.7k buffers and took 4,970 ms
then 9,530 ms.** That is contention, not cache residency — the same control shape as known-issues
#39. It also means *timings here are only comparable to each other*; the buffer counts are the
durable figures.

### After VACUUM

| state | buffers | heap fetches | elapsed |
|---|---:|---:|---:|
| before, via the view (exactly as production calls it) | 74,754 | 66,218 | 4,970–9,530 ms |
| after VACUUM, via the view (production's own shape) | **28,928** | **0** | **2,466 ms** |
| after VACUUM, with the collection predicate pushed down | **13,835** | **0** | **1,198 ms** |

And measured at the level that actually counts — **calling the function as the function**, since a
parameterised function does not plan like inline text:

| payload | before | after |
|---|---:|---:|
| `seller / topshot / l30` | 16,300 ms (and a 16,998 ms `pg_stat_statements` mean) | **2,961 / 2,303 ms** |
| `buyer / allday / l30` | — | 1,590 ms |
| `buyer / all collections / window=all` | — | 1,998 ms |

### Production falsifier

The 10-request sweep the Cowork pass found at 0/10 — 5 collections × 2 roles, the exact fan-out
`WhaleLeaderboard` issues — re-fired against `www.rippackscity.com`:

```
topshot  buyer  200  10006 ms  rows=10      pinnacle buyer  200   5046 ms  rows=10
topshot  seller 200   3333 ms  rows=10      pinnacle seller 200   2393 ms  rows=10
allday   buyer  200   3759 ms  rows=10      ufc      buyer  200    483 ms  rows=0
allday   seller 200   3227 ms  rows=10      ufc      seller 200    558 ms  rows=0
golazos  buyer  200   3550 ms  rows=1
golazos  seller 200   5357 ms  rows=1
ok=10 fail=0
```

⚠ Ten probes, not one — one probe cannot distinguish a fix from a lucky call on a route that was
already succeeding 23% of the time. UFC's `rows=0` is honest emptiness (UFC Strike moved to Aptos),
not a failure. ⚠ Latencies from this box are a **different egress** and are not attributable.

---

## ⚠ What is NOT established — read this before treating it as closed

**The mechanism is open, and I am recording that rather than papering over it.**

The obvious story — *"autovacuum never fires on this table"* — is **refuted by measurement**.
`sales_2026` already carries tuned reloptions (`autovacuum_vacuum_insert_threshold=2000`,
`insert_scale_factor=0.01` ⇒ ~12.4k inserts ⇒ roughly every 3 days at ~4k inserts/day), and
`autovacuum_count` was 11 with the last run on 08-24. Autovacuum runs, and still left 66k heap
fetches. Any fix premised on "just lower the scale factor" is addressing something that is
already configured.

What actually happened: a first plain `VACUUM` moved heap fetches only 66,218 → 54,923. A second
one about ten minutes later — with `DISABLE_PAGE_SKIPPING`, **and** after the heavy `EXPLAIN`
scans had drained — took them to 0. **Those two runs differ in two variables at once** (the flag,
and the xmin horizon those 5–15 s scans were holding back). I cannot attribute the difference to
either, so I am not claiming the flag is the lever.

The self-reinforcing loop is a plausible story — slow analytics scans hold back the xmin horizon,
which keeps recent tuples from being marked all-visible, which keeps the scans slow — but **a
plausible mechanism is not a measurement**, and it has not been tested.

---

## Shipped

1. **`VACUUM (DISABLE_PAGE_SKIPPING) public.sales_2026`** — the fix. `relallvisible` 79.4% → **100%**.
2. **`VACUUM (ANALYZE) public.sales_2025`** — a separate real defect found on the way: this
   partition had **never been vacuumed or analyzed** (`last_autovacuum` null, `vacuum_count` 0) and
   its `n_live_tup` read **77** against 748,034 actual rows. Any planner decision touching 2025
   sales was working from that. Now 749,516 and 100% all-visible.
3. **`VACUUM (ANALYZE) public.pinnacle_sales`** — the other leg of the `analytics_sales` UNION, at
   78.4% all-visible and never manually maintained.
4. **pg_cron `maint-vacuum-sales-hot-partition` (jobid 380), `20 10 * * *`** — nightly
   `VACUUM (ANALYZE) public.sales_2026` at 03:20 PT. Hour 10 UTC carries one other job and sits
   outside both the traffic peak and the 1am-PT nightly pass.
   Migration `20260829002812`. Revert: `select cron.unschedule('maint-vacuum-sales-hot-partition');`

**Item 4 is a hedge, not a proven mechanism fix** — deliberately a plain `VACUUM`, the standard
low-cost maintenance op, rather than the diagnostic `DISABLE_PAGE_SKIPPING`.

**FALSIFIER, 24–48 h:** re-run the `l30` `EXPLAIN (ANALYZE, BUFFERS)`. If `Heap Fetches` has climbed
back above ~10,000 with the nightly job running, a plain `VACUUM` is insufficient — escalate to
`DISABLE_PAGE_SKIPPING` and re-open why autovacuum leaves the recent slice dirty.


---

## Verified from outside, 2026-08-29 00:53–00:57Z (Cowork) — plus one item the fix left behind

A separate session re-read the outcome without touching the DB state that produced it:

- `sales_2026` / `sales_2025` / `pinnacle_sales` — **all 100% all-visible** (`relallvisible = relpages`).
- Vercel production, `/api/analytics/sales/leaderboard`: **10 × 200 and ZERO 500s since 23:13Z.**
  ⚠ The 10 × 500 still sitting in the 6 h bucket are the **pre-fix 22:38Z burst** — read the
  timestamps, not the bucket total, or the fix reads as a failure.
- **`ANALYZE public.sales_2026` run at 00:54Z.** The manual `VACUUM` in item 1 left `last_analyze`
  at 08-26, so the planner was on three-day-old stats for the hot partition immediately after the
  work that changed it. Jobid 380 keeps it current from here.

### 5. Unscheduled the spent one-shot — `57 22 28 8 *` IS NOT A ONE-SHOT

⚠ pg_cron jobid **379 `tmp-vacuum-pack-rips`**, created during this investigation, carried
day-of-month 28 **and** month 8. That is not "once": it re-fires at 22:57Z on **28 August every
year**, indefinitely, as an unannounced `VACUUM (ANALYZE) public.pack_rips` owned by `postgres`,
in a slot nobody will remember allocating. It was already spent — `cron.job_run_details` shows
exactly ONE run (2026-08-28 22:57Z, `succeeded`, 33.6 s, `VACUUM`) and nothing pending.

Migration `20260829005435`, applied 00:54:35Z, committed as
`supabase/migrations/20260829005435_audit_20260829_unschedule_spent_tmp_vacuum_pack_rips.sql`
(byte-exact to the applied statement: md5 `c953d610b6adf76c5628ae6bc4da6358` over `statements[1]`,
2,694 chars). It is **guarded** — it refuses unless the schedule and command are exactly what was
measured, and it asserts a **positive control** that jobid 380 survives, so a repurposed job of the
same name is rejected rather than silently unscheduled.

Post-flight, read from outside the migration: `tmp-vacuum-pack-rips` rows = **0**;
`maint-vacuum-sales-hot-partition` = **jobid 380 · `20 10 * * *` · `VACUUM (ANALYZE) public.sales_2026` · active**.

**Revert:** `SELECT cron.schedule('tmp-vacuum-pack-rips', '57 22 28 8 *', 'VACUUM (ANALYZE) public.pack_rips');`
⛔ Do not re-apply the migration to this project — it is already recorded and would `RAISE EXCEPTION`
by design, the job being gone.

---

## Deliberately NOT shipped

⛔ **The collection-predicate push-down**, worth a further 28,928 → 13,835 buffers (−52%).

`analytics_sales` maps long-form → short-form collection through a `CASE`:

```sql
CASE s.collection WHEN 'nba_top_shot' THEN 'topshot' ... END AS collection
```

`idx_sales_2026_pulse_window` leads on `(collection, sold_at DESC)` — the **long** form. So
`s.collection = ANY('{topshot}')` against the view is a **Filter**, never an Index Cond, and the
leading column goes unconstrained: the scan sweeps every collection's `sold_at` range instead of
one. Push it to the base table and `Index Cond` becomes
`(collection = 'nba_top_shot' AND sold_at >= …)`, with the estimated cost falling 36,096 → 3,959.

It is measured, semantics-preserving and real — but the vacuum alone already takes the function to
2.3 s against a 30 s `service_role` timeout, and bundling a rewrite of a live user-facing function
into tonight's fix buys margin nobody is short of. **Filed, not shipped.** It is the right next
move if this surface needs more headroom.

⛔ **Materialising the leaderboard** is now moot and should not be revived on these grounds. It was
the Cowork pass's live candidate, and it would have been a real product decision (freshness) plus a
new rollup table and refresh job — to solve a stale visibility map.

---

## The part worth generalising

⚠ **`Heap Fetches` on an Index Only Scan is a first-class cost signal, and nothing here was reading
it.** Every prior pass on this route read latency, `pg_stat_statements` means, and buffer totals —
all of which said "expensive query" and pointed at the SQL. The SQL was fine. The plan node named
the cause in one line.

⚠ **The same table carries ~20 indexes, many of them `INCLUDE`-covering** (`idx_sales_2026_*_cover`,
`idx_sales_2026_fmv_recalc_window`, …). A stale VM defeats index-only scans for *all* of them, so
this may not be the only surface that was paying it. `sales` is IO-heavy and this instance is
IO-bound — worth a sweep, not assumed.

⚠ **An age-matched control is what made this legible.** Comparing the hot window against a
60–90-day-old window of near-identical row count held everything constant but age. A before/after
on the hot window alone would have been confounded by the contention that made two identical runs
differ 2×.
