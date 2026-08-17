# `topshot-wmc-fossil-drain` times out proving emptiness — and it is on no watchlist, so neither arm sees it

> ✅ **RESOLVED 2026-08-17 18:19Z — the blocking measurement was taken and it chose option 2, NOT option 1.**
> The fossil population is **exactly ZERO**: a chunked recursive loose index scan enumerated **all 11,799
> distinct Top Shot `edition_key`s** in `wallet_moments_cache` (4,000 + 4,500 + 3,299 — the recursion
> **exhausted**, and nothing sorts after the terminator `99:3765` or before `1`); **none is non-canonical**.
> Corroborated by the two cheap proofs already in this doc plus a third: **0 of the 6,561 non-canonical
> `editions.external_id` are present in wmc**. So the weekly `?wmc=1&rekey=1` cron entry was removed from
> `vercel.json` (**37 → 36**) and the route KEPT — this doc's own decision rule ("if the population is zero,
> option 2 is free and options 1/3 are wasted work on the platform's hottest table").
>
> ⚠ **The open question in "What I could NOT establish" is answered, and by neither hypothesis offered
> there.** The recursive-CTE loose scan **is** correctly planned as a two-column index seek — but each seek
> costs **10.1 ms** with **`Heap Fetches: 1054/1999`**, because the visibility map does not pay off on the
> platform's most write-heavy table. 11,799 seeks ≈ 120 s: correctly shaped and genuinely too slow, not a
> planning failure. ⚠ **The asymmetry that made the measurement possible at all: an ABSENT key is a cheap
> seek, a PRESENT one is not** — 6,561 absent-key probes returned instantly.
>
> ⚠ Two corrections to this doc's framing: the **~13–20k distinct-key estimate was high** (11,799 actual),
> and its "the production query walks ~445k ROWS" remains right — that is why the direct scan still exceeded
> 55 s even in a quiet window. ⚠ **NULL `edition_key` rows exist but are NOT fossils** (`NULL !~ pattern` is
> NULL, so the targets RPC already excludes them) — worth stating, since it reads like a hole in the proof.
>
> Guard: `__tests__/fossil-drain-schedule-is-retired.test.ts` (8/8 mutations killed). The "nothing watches
> it" half is **accepted, not fixed** — see the ledger entry for why a watchlist row would make the
> `Pipeline Success Coverage` arm flap at a weekly cadence.

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

**The actual fossil count.** Five probes; the two cheap ones answered, the three scans did not.

**Answered, and they narrow the question usefully:**

- ✅ **There are ZERO letter-leading fossils.** An index *seek* — `edition_key >= 'a'` ordered by
  `(collection_id, edition_key)` — returned **empty, instantly**. Every canonical Top Shot key is
  digit-leading, so any key sorting at or after `'a'` would be a fossil. This rules out roughly 10 of the
  16 possible leading hex characters of a UUID.
- ✅ **That same seek proves option 3 below is cheap, and it is now QUANTIFIED.** `EXPLAIN (ANALYZE,
  BUFFERS)` on one seek, taken on the saturated instance:
  ```
  Limit (actual time=6.138..6.140 rows=1 loops=1)  Buffers: shared hit=4 read=1
    -> Index Only Scan using idx_wmc_coll_ek_serial_cover
         Index Cond: ((collection_id = '95f28a17-…') AND (edition_key > '1:1'))
         Heap Fetches: 0
  Execution Time: 6.216 ms
  ```
  **6.2 ms, 5 buffers, zero heap fetches, a true two-column index cond.** The index the function needs
  already exists and is perfectly shaped for it; it is simply not being chosen, because the negated regex
  is not a range and the `ORDER BY moment_id` makes the *other* index look free.
- ✅ **And that number explains the failed loose scan rather than leaving it a mystery.** At 6.2 ms per
  seek, walking ~13–20k distinct Top Shot keys costs **~80–124 s** — at or over the 120 s global budget,
  which is exactly why the recursive-CTE attempt died. So the loose scan is *correctly shaped but too
  slow at this seek latency*; it is not a planning failure. **The production query is far worse still: it
  walks ~445k ROWS, not ~20k keys.**

**Not answered — the residual is digit-leading UUIDs** (e.g. `0f3a1b2c-…`), which interleave with canonical
keys and cannot be isolated by a range seek. Three attempts timed out: `limit 5000` on the matching set at
25 s; a scan bounded to 150,000 rows at 40 s; and a **recursive-CTE loose index scan over DISTINCT keys** at
45 s (the cheapest correct shape, ~1 seek per distinct key — that it still timed out means either the
distinct-key count is far above the ~20k assumed, or the correlated subquery is not being planned as a seek;
worth re-checking, since if the loose scan CAN be made to work it answers this in about a second).

⚠ **These timings are confounded and must not be quoted as the query's cost.** Measured in the same window:
25 active connections with **15 in IO wait**, and the sentinel run that verified the new arm showed
`Sales Ingest`, `FMV Confidence` and `Sniper Feed` all going `INCONCLUSIVE (db saturated)`. That is
CLAUDE.md's own warning that your profiling is itself saturation. Re-measure in a quiet window before
sizing any fix.

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

⚠ **CORRECTION to my own first draft of this section, which said the flapping is "worse than absence
because the clean readings read as a verdict". That is WRONG, and I checked the copy rather than trusting
the reasoning.** The arm's healthy detail is scoped explicitly — *"All N watchlisted pipelines **that ran
since `<day>`** produced at least one success or wrote rows"* — so on the six silent days it makes **no
claim at all** about a pipeline that did not run in the window. It is not dishonest. The real cost is
**ergonomic**: you hear about the failure one day in seven, with a six-day gap in which nothing reminds
you, which is materially weaker than continuous coverage but strictly better than the zero coverage it has
today. I had reasoned about the shape instead of reading the string.

⚠ **That mismatch does not affect anything watchlisted today** — measured 2026-08-17, the longest
`max_silent_minutes` on the active watchlist is **1800 (1.3 days)**, so every current entry sits inside the
window with margin. This pipeline would be the first exception. If long-cadence pipelines are going to be
watchlisted, the arm should take its window from `max_silent_minutes` (e.g. `max(48 h, 2 × cadence)`)
rather than a fixed two days; that keeps the rollup read well under the 1000-row cap the arm already guards.
