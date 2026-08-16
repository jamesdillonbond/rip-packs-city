# `fmv_current` does not push a JOIN predicate through its `DISTINCT ON` — 1.05M buffers to fetch 40 rows

Filed 2026-08-16 11:29 PT (18:29Z), continuing the `:13` pg_cron investigation.
**Not shipped: every implicated object is pack-EV / FMV / sentinel, which are off-limits for
autonomous change. This is a measured filing, not a recommendation to act blind.**

## How I got here

Chasing jobid **71** (`rpc-backfill-historical-pack-ev`, `13 * * * *`, `cron_heavy`) — the standing
hourly load that the `:13` stagger deliberately does **not** address. 7 d: 155 ok (avg 127 s, max
403 s) and **13 failed**. The failures split, and the split matters:

- **10 x `canceling statement due to statement timeout`, avg 601 s** — dying inside
  `compute_pack_ev_per_edition_weighted`, specifically its `pack_drop_pool LEFT JOIN fmv_current` leg.
- **3 x `job startup timeout`, avg 21 s** — pg_cron could not launch a background worker at all.
  **That is a whole-instance saturation signal, not this job's fault**; do not fold it into the other 10.

The 10 are a single statement, so a timeout rolls back everything: **~100 minutes per week of
`cron_heavy` time producing exactly zero rows**, on the instance whose saturation is the platform's
number-one problem.

## The measurement

`fmv_current` is `SELECT DISTINCT ON (edition_id) ... FROM fmv_snapshots ORDER BY edition_id,
computed_at DESC` — **no WHERE clause at all**. `DISTINCT ON` is an optimization fence for anything
except a predicate the planner can turn into an index condition on the distinct key. Three shapes,
same 5-40 target editions, measured with `EXPLAIN (ANALYZE, BUFFERS)`:

| shape | buffers | rows scanned | time |
|---|---|---|---|
| **literal** `IN (a,b,c,...)` | **335** | 322 | **83 ms** |
| `JOIN fmv_current ON edition_id` | **1,046,192** | 1,098,327 | **28.7 s** |
| `IN (SELECT ...)` (Hash Semi Join) | **1,087,386** | 1,141,629 | **34.9 s** |

**~3,100x apart.** The literal list becomes `Index Cond: edition_id = ANY (...)` and touches three
index scans. The other two materialize **every one of the ~26,000 editions' latest snapshot** and
then filter — to answer a question about 40 of them.

That is jobid 71's entire cost: 15 dists x ~28 s is already past the 600 s budget before anything
else on the box competes for IO.

## Blast radius — and what is NOT implicated

**5 DB functions JOIN it** (the expensive shape):
`compute_pack_ev_per_edition_weighted` (jobid 71's callee, confirmed by the timeout's CONTEXT),
`compute_pack_ev_from_pool`, `compute_pack_ev_from_pool_tier_weighted`,
`backfill_pack_rip_metadata` (hourly cron at `:53`), and **`sentinel_edition_coverage`** — a health
check paying a full-table `DISTINCT ON` every time it runs.

The other 6 DB functions, 7 views, 1 matview and 19 repo files use a different shape and need
individual checking before anyone assumes they are affected.

⚠ **`/api/fmv` is FINE and must not be "fixed".** It reads `fmv_current` with 500-chunked supabase
`.in()`, which PostgREST renders as a **literal** id list — the 83 ms row above. The D27 change that
moved it onto this view was correct. **Do not read this filing as evidence against that fix.**

## Three hypotheses I held and measurement killed

1. **"Add `computed_at <= now()` for partition pruning."** The documented `get_pack_detail_bundle`
   win (9,131 -> 6,308 buffers) does not apply: the empty `fmv_snapshots_2025` / `_2027` partitions
   cost **1 buffer each here**. Pruning them saves ~2 of 1,046,192. **Three orders of magnitude off
   the actual problem** — and it is the fix I would have shipped had I not run the EXPLAIN.
2. **"Jobid 71 is starved by a poison set."** The insert requires `sec_ask IS NOT NULL` and the
   survivor-bias cap, while the `NOT EXISTS` recency gate is only satisfied by an inserted row — so
   rejected candidates should recur forever. Measured: **388 candidates, only 5 lack an ask.** Not
   the mechanism.
3. **"Stagger jobid 71 away from jobid 217"** (`refresh_atlas_pack_ev`, `25 * * * *`, the other
   hourly pack-EV writer, 12 min later). Measured **0 overlapping pairs across 168 x 168 runs**.
   They never actually collide. Consistent with the standing lesson that overlap tracks duration,
   not start minute.

## Candidate fixes — none applied, each with its trap

- **A lateral/scalar accessor** (`... FROM pack_drop_pool pdp CROSS JOIN LATERAL (SELECT fmv_usd FROM
  fmv_snapshots WHERE edition_id = pdp.edition_id ORDER BY computed_at DESC LIMIT 1)`) — turns the
  fence into one index probe per row. Changes callers, not the view; nothing else regresses.
- **Materialize `fmv_current`** with a unique index on `edition_id`. Buys O(1) reads at the cost of a
  refresh job and staleness — and staleness on FMV is a product decision, not an optimization.
- ⛔ **Do NOT `CREATE OR REPLACE VIEW fmv_current`.** It currently carries
  **`reloptions = {security_invoker=true}`**, and a `CREATE OR REPLACE` with no `WITH` clause
  **RESETS reloptions and silently strips it** — the footgun this repo has already paid for four
  times, and a view's security mode is invisible in its output. Use `ALTER VIEW`, or restate the
  `WITH` clause.

## Why nothing shipped

pack-EV logic, FMV/pricing, and ingest are explicitly off-limits for autonomous change, and all five
implicated functions sit in exactly those lanes. The jobid 71 levers that are *not* logic changes
were considered and rejected on their merits: **lowering `p_limit`** cuts runtime but reduces refresh
coverage on a queue already 388 behind, and pack-EV publishes a public **+EV buy signal** — making it
staler is a product change wearing an optimization costume.

## To reproduce

```sql
explain (analyze, buffers, timing off)
select pdp.drop_weight, fc.fmv_usd
from pack_drop_pool pdp
left join fmv_current fc on fc.edition_id = pdp.edition_id
                        and fc.collection_id = pdp.collection_id
where pdp.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  and pdp.dist_id = '<any dist>';
```

⚠ Read it warm-vs-cold and remember that a single 28 s statement on this instance is itself a
saturation contributor — your own profiling is a confound.
