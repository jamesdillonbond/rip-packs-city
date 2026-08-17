# ⛔ REFUTED TWICE, ROOT CAUSE FOUND: pack-EV is slow because `fmv_current` never pushes down — not because the 12 h target is unaffordable

⚠ **The filename is now HISTORICAL.** The "12 h target it can never hit" claim is the thing this
document refutes. Kept at the original path so the finding has one home.

Claude Code on Trevor's box, 2026-08-17 08:37 PT / 15:37Z. Measured live. **Nothing shipped** — see
"Why not shipped" at the end.

---

## The headline: TWO successive versions of this finding were wrong, and both were wrong the same way

| version | claim | verdict |
|---|---|---|
| original (02:25Z) | per-item cost ≈ **14.5 s** ⇒ the 12 h target is unaffordable ⇒ **relax the window to 36 h** | ⛔ **REFUTED** |
| amendment (~15:00Z) | ~1.4 s warm; cost is **16 tail dists** ⇒ **attack the tail, keep the window** | ⛔ **ALSO REFUTED** |
| this pass | **every dist walks 1,149,004 rows** regardless of size; the shape is the defect | ✅ measured |

Both earlier versions reasoned from **wall-clock timings of a few dists** and tried to explain the
*spread* between them (14.5 s mean → "too expensive"; 1.3 s warm vs 35 s big → "a tail"). Neither
opened the query plan. The spread is real and is a **red herring** — it is how far a merge join
happens to walk before it exhausts, not a per-item cost.

## What the plan actually says

`EXPLAIN` on **dist 1211 — a 21-row dist**, the cheapest case available:

```
Merge Right Join  (cost=1.12..70557.93 rows=21)
  ->  Subquery Scan on fc
        Filter: (fc.collection_id = '95f2…'::uuid)
        ->  Unique  (cost=0.70..70369.36 rows=13230)
              ->  Merge Append  (cost=0.70..67496.85 rows=1149006)
                    ->  Index Scan ... on fmv_snapshots_2026  (rows=1149004)
  ->  Index Scan using pack_drop_pool_pkey on pack_drop_pool pdp  (rows=21)
```

**A 21-row dist scans the entire 1,149,004-row `fmv_snapshots_2026` partition** through the
`DISTINCT ON`. There is no plan flip, no size threshold, and no per-item cost curve. The
`LEFT JOIN fmv_current` in `compute_pack_ev_per_edition_weighted` **never pushes the `edition_id`
predicate down**, so the cost floor is the whole table, every call, for every dist.

⚠ This is a **previously recorded** mechanism, not a new one: `fmv_current` pushdown is
shape-dependent — a literal `IN` pushes down, a `JOIN` does not. It had not been connected to
pack-EV.

## The fix, priced

Replace the `LEFT JOIN fmv_current` with a correlated per-row lookup against `fmv_snapshots`
(carrying the `computed_at <= now()` runtime-pruning trick this repo already uses):

| dist 4184 — the largest, **3,097 pool rows** | current `LEFT JOIN fmv_current` | correlated lookup |
|---|---|---|
| cold | ⛔ **cannot complete — statement timeout** | **35 ms** |
| warm | ⛔ **cannot complete** | **7 ms** |

The single most expensive dist on the platform — the one the amendment flagged as *unmeasured* and
extrapolated at ~30 s — **cannot be computed at all today**, and completes in **35 ms** under the
corrected shape.

### Equivalence verified before recommending it (this is a pricing path)

`fmv_current` is `DISTINCT ON (edition_id)` keyed on **edition_id alone**, with `collection_id`
filtered *after*. The replacement filters *before*. Those differ if any edition_id carries snapshots
under more than one collection — so I measured instead of assuming:

- **edition_ids spanning >1 collection: `0`** — `collection_id` is functionally dependent on
  `edition_id`, so the two shapes are equivalent on live data.
- **Value-level positive control** (dist 1211, both shapes, same instrument): **25 rows compared,
  0 mismatches, sums identical to the cent (`47.69` vs `47.69`).**

## Scope: 3 functions, all pack-EV, one root cause

```
compute_pack_ev_from_pool                  ← join shape
compute_pack_ev_from_pool_tier_weighted    ← join shape
compute_pack_ev_per_edition_weighted       ← join shape  (the one measured above)
```

The other 8 `fmv_current` callers use a non-join shape and are not implicated.

⚠ **This also explains an existing, separately-filed security finding.** CLAUDE.md records
`compute_pack_ev_from_pool_tier_weighted` as costing **45.8 s / ~17.4 GB per call** while
anon-executable and caller-less (since revoked). That 17.4 GB *is* the 1.15M-row `DISTINCT ON` walk.
**The performance defect and the "unauthenticated 46-second query" were the same defect**, found from
two directions weeks apart.

## What this does to the earlier recommendations

- ⛔ **Do NOT relax the freshness window 12 h → 36 h.** It was proposed as the affordability lever.
  Affordability was never the constraint, so this would trade real freshness on a public board for
  nothing. It is accuracy-negative.
- ⛔ **Do NOT "attack the 16-dist tail."** There is no tail. A 21-row dist and a 3,097-row dist pay
  the same 1.15M-row floor.
- ⛔ **Do NOT cut cadence** — unchanged from the original, and still right: this job is **starved,
  not saturated** (opposite of jobid 215).
- ✅ **Fix the join shape.** The 12 h target then costs ~nothing and no freshness decision is needed
  at all — which is exactly the "alternative worth pricing first" the original doc named and did not
  measure.

## Why not shipped

1. **It is a pricing path.** `compute_pack_ev_*` writes the public **+EV badge**. CLAUDE.md names
   `pack-EV` in the never-auto-ship list.
2. **`compute_pack_ev_per_edition_weighted` is PINNED** (`supabase/tests/compute_pack_ev_per_edition_weighted.sql`).
   Changing it is a coordinated 3-part change — migration + verbatim DDL copy in the pin + drift
   guard — or `db-tests` reds.
3. The other two functions are **unpinned and unmeasured**; I measured one of the three and should
   not assume the other two behave identically just because they share a grep.

**Ship checklist when Trevor wants it:** migration replacing the join in all three ⇒ re-time
`compute_pack_ev_from_pool*` the same way (do not assume) ⇒ update the pin's verbatim DDL ⇒ confirm
`pack_ev_history` values are unchanged for a sample of dists before/after ⇒ ledger entry.

## Limits, stated plainly

- The 35 ms / 7 ms figures are **one dist, two calls**. The equivalence proof is **one dist, 25 rows**
  plus a whole-table functional-dependency check.
- I did **not** re-derive the 597-dist eligible population or the 5,224 worker-s/day figure this pass;
  those are carried from the earlier versions and were not the thing in dispute.
- `EXPLAIN` is a plan, not a measurement — but here the plan is corroborated by the timeout on 4184
  and by the 1000×+ delta, which agree.
