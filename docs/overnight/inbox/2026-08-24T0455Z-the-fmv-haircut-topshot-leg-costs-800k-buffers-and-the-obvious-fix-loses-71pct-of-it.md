# The FMV haircut's Top Shot leg is 800,545 buffers to find 14 rows — and the obvious fix silently loses 71% of them

**Filed 2026-08-23 21:55 PT (2026-08-24 04:55Z) by Claude Code (VSCode, Trevor's box). MEASURED. NOTHING SHIPPED for this item — deliberately.**
Saturation control taken first and held throughout: `io_wait 8 / active 9 / total 47` — a genuinely quiet window, so
these are not throttle-inflated numbers.

## What was asked, and what changed

Owed item #2 from [the read-path filing](2026-08-23T2235Z-the-read-path-attributed-and-two-severity-corrections.md):
*"`apply-fmv-haircut`'s `nba_top_shot` leg — the 08-16 split rescued six collections and left the largest one still
exceeding its per-leg upstream budget on every run."* That is **confirmed**, with the mechanism corrected and the
obvious remedy **refuted by measurement before shipping**.

## 1. The failure is real, and it is the GATEWAY, not `statement_timeout`

Both retained `pipeline_runs` rows (73 h retention) read:

```
1/7 legs failed: nba_top_shot: upstream request timeout   (08-21, 222,613 ms · 08-20, 157,806 ms)
```

⚠ **`upstream request timeout` is the Supabase gateway's ~120 s cap, not Postgres.** The route's own comment
attributes the failure to the global 120 s `statement_timeout` — those two bounds are within seconds of each other,
which is exactly the confusion CLAUDE.md warns produces "the same number meaning completely different things."
The practical consequence is worse than a clean cancel: on the gateway path **the statement is not cancelled when
the client gives up**, so each failed nightly run leaves ~100 s of TS scan still burning after the route has
already recorded the failure.

## 2. The cost, measured

`EXPLAIN (ANALYZE, BUFFERS)` of the read half **alone**, scoped to Top Shot, columns already narrowed to the eight
the function actually uses:

```
Execution Time: 101,425 ms
Buffers: shared hit=780218 read=20327   (800,545 total ≈ 6.25 GB)
Merge Append → Index Scan  fmv_snapshots_2026_collection_id_edition_id_computed_at_idx
  actual rows = 850,490   →  Unique → 19,667 editions  →  filter passes 14
```

**101 seconds and ~6.25 GB of buffer traffic to locate 14 rows.** And `fmv_apply_thin_sale_haircut` performs this
`DISTINCT ON` **twice** — once for the measurement CTE, once inside the `UPDATE ... FROM latest` — so the real leg is
~200 s against a ~120 s gateway. It cannot fit, and it never could.

⚠ **Column projection is NOT the lever, tested rather than assumed.** The unnarrowed `SELECT DISTINCT ON (edition_id) *`
timed out at 110 s; the narrowed eight-column version still took **101.4 s**. The cost is walking 850,490 index
entries, not the width of the rows. This is R46's finding reproduced at function scope: the lever is *less
re-reading of the working set*, not a better-written query.

## 3. ⛔ The obvious fix is REFUTED — it loses 71% of the rows

`edition_fmv_current` (a real table, 13 MB, 27,075 rows, all 5 collections, `refreshed_at` 20:59 PT) materialises
exactly the latest-per-edition that this scan recomputes. Using it as the candidate source is dramatically cheaper:

| step | buffers | time |
|---|---:|---:|
| candidate lookup from `edition_fmv_current` | **1,038** | **363 ms** |
| current `DISTINCT ON` over `fmv_snapshots` | **800,545** | **101,425 ms** |

**771× fewer buffers.** It is also wrong.

Both shapes run **in one statement, sharing one MVCC snapshot** — the only way to compare against a population
`/api/fmv-recalc` rewrites continuously — and diffing the **set**, not the count:

```
old_rows        14
new_rows         4
in_old_not_new  10      ← the cheap shape MISSES 10 of 14
in_new_not_old   0
```

**A 71% recall loss, with zero false positives** — the shape most likely to ship unnoticed, because both versions
return a small plausible number and no error. Applying it would have **silently under-applied the FMV haircut on
~71% of eligible editions**: an accuracy regression in the one subsystem the roadmap calls the gate.

**Why it fails:** `edition_fmv_current` stores its own copies of `fmv_usd`, `floor_price_usd` and `confidence` as of
the last refresh. The haircut predicate (`abs(fmv_usd - floor_price_usd) < 0.01`) is evaluated against those *stale*
copies at step 1, so an edition whose **true** latest snapshot qualifies is dropped before step 2 ever re-derives it.
A lagging materialisation is safe as a *display* source and unsafe as a **filter for a predicate over the columns it
lags on.**

⚠ **This nearly shipped on a moving target.** My first two readings were 1 row and then 4 rows, taken 13 minutes
apart — the eligible population went 1 → 14 within the hour. Had I compared those two numbers I would have called the
cheap shape "close enough". **Only the same-snapshot set difference exposed it.**

## 4. What would actually work, unmeasured and therefore not proposed

Widening step 1 (drop the `abs()` test, keep only `confidence IN ('LOW','ASK_ONLY')`, re-derive everything at step 2)
restores correctness by construction — but the candidate set grows toward the full 19,667 editions and the saving
shrinks by an unknown amount. **That is a hypothesis, not a recommendation.** It needs the same one-statement
set-difference control before anyone acts on it.

## 5. Severity — unchanged from the read-path filing, and still MEDIUM

Not an accuracy breach today. `/api/fmv-recalc` applies the haircut **inline per collection** on every pass; the
daily sweep is a catch-up. Re-verified while measuring: Top Shot `1.7.0_haircut` stamps minutes old,
`topshot_fmv_stale_hours` 0.1 against a breach threshold of 6. The daily leg failing costs the tail, not the
headline.

## Owed

1. **Do not** point the haircut at `edition_fmv_current` as filtered above. If anyone re-proposes it, the refutation
   is the one-statement query in §3 — re-run it, do not quote this file's numbers.
2. The widened-step-1 variant in §4, if the leg is worth fixing at all.
3. ⚠ The gateway-vs-`statement_timeout` misattribution in
   [app/api/admin/apply-fmv-haircut/route.ts](../../../app/api/admin/apply-fmv-haircut/route.ts)'s comment block is
   worth correcting in place — it is load-bearing documentation that currently points the next reader at the wrong bound.
