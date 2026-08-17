# `topshot-wmc-fossil-drain` times out proving emptiness — and it is on no watchlist, so neither arm sees it

Filed 2026-08-17 09:56 PT / 16:56Z (Claude Code, interactive). Found while auditing the coverage of the
`Pipeline Success Coverage` sentinel arm shipped in the same session.

## The state

Three consecutive weekly runs, all identical, all zero output:

| day | runs | ok | rows_written | error |
|---|---|---|---|---|
| 2026-08-03 | 1 | 0 | 0 | `targets: canceling statement due to statement timeout` |
| 2026-08-10 | 1 | 0 | 0 | same |
| 2026-08-17 | 1 | 0 | 0 | same |

That is its entire history in `pipeline_runs_daily` (the rollup starts 2026-07-29), so **it has never
succeeded inside the observable window.** Route: `app/api/admin/drain-topshot-misattribution?wmc=1&rekey=1`
(`vercel.json`), which selects the targets RPC `topshot_wmc_fossil_targets`.

## ⚠ It is watched by NOTHING, and that is two independent misses

- **Not on `pipeline_cadence_watchlist`** — verified, no row. So the cadence arm does not see it.
- **Therefore the new `Pipeline Success Coverage` arm does not see it either**, because that arm is
  deliberately scoped to the active watchlist so it cannot fire on something nobody chose to monitor.
- ⚠ **And it is absent from `pg_stat_statements` despite having run today.** Consistent with a statement
  that always errors never accumulating there. **A permanently-failing query can be invisible in the very
  view you would reach for to find expensive queries** — worth knowing beyond this pipeline.

It would fire on the success arm the moment it is watchlisted (runs 1, ok 0, rows 0 — see the caveat
under "If you watchlist it" below, which is NOT free).

## Mechanism — a planner-selectivity trap, and the third instance of a documented shape

```sql
CREATE OR REPLACE FUNCTION public.topshot_wmc_fossil_targets(p_limit integer DEFAULT 1200)
 RETURNS TABLE(nft_id text) LANGUAGE sql SECURITY DEFINER
 SET search_path TO 'public' SET statement_timeout TO '120s'
AS $function$
  SELECT DISTINCT w.moment_id::text
  FROM wallet_moments_cache w
  WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND w.edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ORDER BY w.moment_id::text
  LIMIT GREATEST(1, p_limit);
$function$
```

`EXPLAIN` (planner only, so not confounded by the live saturation):

```
Limit  (cost=0.43..272.60 rows=1200 width=9)
  ->  Unique  (cost=0.43..100151.91 rows=441570 width=9)
        ->  Index Only Scan using idx_wmc_moment_collection_cover on wallet_moments_cache w
              (cost=0.43..99038.04 rows=445548 width=9)
              Index Cond: (collection_id = '95f28a17-...'::uuid)
              Filter: (edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text)
```

Three things compound:

1. **The planner estimates 445,548 rows pass the filter** — i.e. it assumes essentially *every* Top Shot
   wmc row is a fossil. Postgres cannot estimate a negated regex, so it falls back to a default that
   makes the negation look unselective. The `LIMIT 1200` is therefore priced at **cost 272**, as if the
   first 1,200 matches turn up immediately.
2. **The real population is small or zero** (the drain exists to empty it), so the LIMIT is never
   satisfied and the scan runs to the end of the index — ~445k entries — every tick.
3. **The index it picks is `(moment_id, collection_id)`, where `collection_id` is NOT the leading
   column**, so the collection condition is an in-scan filter rather than a seek. It is chosen because
   its `moment_id` order satisfies the `ORDER BY` for free (no Sort node), which is exactly the wrong
   trade when the LIMIT never fills.

⚠ **This is the third recorded instance of "the selection query is the expensive part", and the second of
"an empty result is the most expensive case"** — after `topshot-flowty-unmapped-drain` (retired on exactly
this reasoning) and `wallet-username-resolver`. The tell CLAUDE.md already gives is present verbatim: **a
timeout with `rows_found: 0`.**

⚠ The declared `SET statement_timeout TO '120s'` is **inert** (the documented `proconfig` rule, re-proved
in both directions on 2026-08-17). The kill comes from the global 120 s. **Raising the declaration is the
one guaranteed no-op** — do not reach for it.

## What I could NOT establish, stated rather than guessed

**The actual fossil count.** Three bounded probes all timed out under the live saturation spell:
`limit 5000` on the matching set at 25 s; a scan bounded to 150,000 rows at 40 s; and the plain count.
The same sentinel run that verified the new arm showed `Sales Ingest`, `FMV Confidence` and `Sniper Feed`
all going `INCONCLUSIVE (db saturated)` in that window, so **these timings are confounded and must not be
quoted as the query's cost** — CLAUDE.md's own warning that your profiling is itself saturation. Re-measure
in a quiet window before sizing any fix.

## Options, with the trade-off each carries

1. **A partial index whose predicate IS the filter** — the textbook answer to "proving emptiness is
   expensive", because an empty predicate yields an empty index and the scan returns immediately:
   ```sql
   CREATE INDEX CONCURRENTLY idx_wmc_ts_fossil_targets
     ON wallet_moments_cache (moment_id)
     WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$';
   ```
   ⚠ **Not shipped, and the objection is real:** `wallet_moments_cache` already carries 14 indexes over
   ~1.6 GB and is the most write-heavy table on the platform — the same reason `fmv_confidence` was
   deliberately left unindexed and the `match-topshot-players` index was declined. A *partial* index over a
   near-empty predicate is cheap in storage, but every insert/update still evaluates the predicate.
   ⚠ `CREATE INDEX CONCURRENTLY` must be a standalone `execute_sql`, never inside `apply_migration`.
2. **Retire the schedule** (the `topshot-flowty-unmapped-drain` disposition) — correct **only if** the
   fossil population is genuinely zero, which is the thing I could not measure. Keep the route.
3. **Re-point the function at `idx_wmc_coll_ek_serial_cover (collection_id, edition_key, serial_number)
   INCLUDE (moment_id)`**, which already exists and *does* lead on `collection_id`. It cannot serve the
   negated regex as a range, but it would at least bound the scan to Top Shot rather than filtering the
   whole `moment_id` index. Requires dropping the free `ORDER BY` ordering and accepting a Sort.

**Do the measurement first.** If the population is zero, option 2 is free and options 1/3 are wasted work
on the platform's hottest table; if it is non-empty, the drain has never drained and option 1 is the fix.

## ⚠ If you watchlist it, know what it does to the success arm

Adding a `pipeline_cadence_watchlist` row makes it visible, but the new arm's window is **24–48 h** while
this pipeline is **weekly**. It would therefore fire on the day it runs and fall silent for six days
(`runs = 0` puts it out of scope), so the arm's reading would flap rather than state a stable fact.

⚠ **That mismatch does not affect anything watchlisted today** — measured 2026-08-17, the longest
`max_silent_minutes` on the active watchlist is **1800 (1.3 days)**, so every current entry sits inside the
window with margin. This pipeline would be the first exception. If long-cadence pipelines are going to be
watchlisted, the arm should take its window from `max_silent_minutes` (e.g. `max(48 h, 2 × cadence)`)
rather than a fixed two days; that keeps the rollup read well under the 1000-row cap the arm already guards.
