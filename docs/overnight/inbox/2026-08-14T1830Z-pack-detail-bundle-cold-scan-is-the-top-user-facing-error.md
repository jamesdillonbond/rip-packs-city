# `get_pack_detail_bundle` cold-scans 3k× per pack page — the top user-facing error on the board

Filed 2026-08-14 (Claude Code, interactive). **Read-only investigation. Nothing
shipped** — the fix is a change to a hot-path DB function and the instance was
saturated throughout, so both the ship and the confirming measurement want a
quiet window. See "Why I did not take it" at the bottom.

## The error

`JAVASCRIPT-NEXTJS-1Z` — **40 users / 43 events in 7 days**, the highest USER
count on the board.

```
Error: pack detail bundle unavailable: TimeoutError: The operation was aborted due to timeout
Culprit: GET /[collection]/pack/dist/[distId]
```

⚠ **The page is already correct.** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx:224`
throws deliberately (deep-audit D10) so a transient failure renders a retryable
error boundary rather than a soft-404 on a real pack, and `fetchPackDetailBundle`
already goes through `rpcWithRetry`. So this is **not** a missing bound or a
missing error-vs-absent split — those are both in place. The RPC is genuinely
too slow cold, and the bound is doing its job.

## Measured

`get_pack_detail_bundle(topshot, <dist>, 'nba-top-shot')`, via
`EXPLAIN (ANALYZE, BUFFERS)`:

| dist | pool rows | cold | warm |
|---|---|---|---|
| 996 | small | **1,247 ms** | — |
| 4184 | **3,097** | **18,951 ms** | **406 ms** |

**47× cold/warm on 1,800 buffer reads (~14 MB).** At the throttled 22 MB/s
baseline that is ~0.65 s of actual IO, so the 19 s is **queueing**, not bytes —
each probe waiting behind the maintenance queries that were running at the time
(`refresh_wmc_fmv_changed` 361 s, `dedup_allday_cross_source_sales` 182 s, a
`mv_topshot_pack_realized_ev` refresh). This is the documented shape: *a
pool-acquire/timeout is a SATURATION symptom, not proof of an inherently slow
query — profile warm vs cold first.*

## Root cause

The hero-editions leg scores FMV with a **correlated subquery per pool edition**:

```sql
with scored as materialized (
  select pdp.edition_id, pdp.drop_weight,
         (select fs.fmv_usd from public.fmv_snapshots fs
            where fs.edition_id = pdp.edition_id
            order by fs.computed_at desc limit 1) as fmv_usd
  from public.pack_drop_pool pdp
  where pdp.collection_id = p_collection_id and pdp.dist_id = p_dist_id
    and pdp.drop_weight > 0
)
```

For dist 4184 that is **3,097 probes**. The probes ARE index-backed —
`(edition_id, computed_at DESC)` exists on every partition — but:

⚠ **the subquery filters on neither `collection_id` nor the partition key**, so
the planner must probe **every partition** (2025 / 2026 / 2027 …) per edition
and merge. Call it ~9,000+ index probes for one page render.

⚠ **And that is exactly what makes the best available index unusable.**
`fmv_snapshots_2026_coll_ed_ct_fmv_idx` is
`(collection_id, edition_id, computed_at DESC) INCLUDE (fmv_usd)` — an
**index-only** scan for precisely this lookup, no heap fetch — but it is
unreachable without a `collection_id` predicate.

## Proposed fix (cheapest first)

1. **Add `and fs.collection_id = p_collection_id` to the correlated subquery.**
   One predicate; unlocks the INCLUDE index on the hot partition and prunes the
   other partitions.
2. If that is not enough, bound `computed_at` (e.g. `>= now() - interval '1 year'`)
   so partition pruning is explicit rather than incidental.

⚠ **Safety of (1) is LIKELY but NOT PROVEN.** It is only equivalent if every
`fmv_snapshots` row for an edition carries that edition's own `collection_id`.
A 2,000-row sample against `editions` showed **0 mismatches**, and
`collection_id` is `NOT NULL` on the FMV write path — but **a sample is not a
proof**, and the full-table check timed out under saturation. Run the full
`count(*) ... where fs.collection_id is distinct from e.collection_id` in a
quiet window before shipping. If it is ever non-zero, (1) silently drops hero
editions and the fix must be (2) alone.

⚠ **Do not "simplify" this into a join against `fmv_current`.** That view is
`DISTINCT ON` over the whole table; for a 3k-edition pool the planner may well
choose to materialize far more than 3k rows. It might still win — but it is a
different plan, not obviously cheaper, and it must be measured rather than
assumed.

## Why I did not take it

- It is a **prod DB function change on the platform's most-visited entity page**,
  and `apply_migration` itself costs a ~10–20 s burst of user-facing `PGRST002`
  500s — so it wants a low-traffic window, not an active saturation spell.
- The confirming measurement (before/after cold timing) is **meaningless while
  the instance is saturated**; the 19 s number itself is a saturation reading.
- Continuing to hammer a struggling instance with exploratory heavy joins
  degrades the very pages this is meant to help. Two of my exploratory queries
  already blew the 60 s MCP budget.

## Verification when it is taken

1. Full mismatch check above returns 0.
2. `EXPLAIN (ANALYZE, BUFFERS)` on dist **4184** in a quiet window, before and
   after — the plan should show an **Index Only Scan** on
   `fmv_snapshots_2026_coll_ed_ct_fmv_idx` and the other partitions pruned.
3. Compare the returned `hero` JSON **byte-for-byte** before and after on a few
   dists, including one with editions priced only in an older partition — that
   is the case where a partition-pruning change would silently lose a hero.
4. Watch `JAVASCRIPT-NEXTJS-1Z` user count over the following days.
