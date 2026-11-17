# The accuracy gate, measured: 31.3% at HIGH/MEDIUM — and it tracks LIQUIDITY, not the pricing algorithm

**Filed 2026-08-21 ~19:56 PT (2026-08-22 02:56Z), Claude Code interactive. MEASURED, read-only.
No action taken — the implications are product decisions.**

The roadmap's thesis is *"accuracy is the GATE, not a phase … headline metric is the share of prices at
HIGH/MEDIUM confidence."* I could find **no view, no dashboard and no recent measurement** of that number
(`pg_views` matching `%accuracy%`/`%coverage%`: **0**). This is it, with the structure behind it.

---

## The headline number

**9,224 of 29,514 priced editions are HIGH or MEDIUM = 31.3%**, across the five published collections.

| collection | priced editions | HIGH+MED | **%** | sales / 30d | sales per edition / month |
|---|---:|---:|---:|---:|---:|
| disney_pinnacle | 2,564 | 1,086 | **42.4%** | (separate pipeline) | — |
| nba_top_shot | 19,667 | 6,731 | **34.2%** | 108,322 | **5.51** |
| nfl_all_day | 6,190 | 1,407 | **22.7%** | 10,482 | **1.69** |
| laliga_golazos | 575 | 0 | **0.0%** | 99 | **0.17** |
| ufc_strike | 518 | 0 | **0.0%** | 0 | **0.00** |

⚠ **Each collection was read from its OWN home table.** Pinnacle FMV is render-keyed on
`pinnacle_catalog.fmv_confidence` and is **not in `fmv_snapshots`**; Pinnacle sales are in
`pinnacle_sales`, not `sales`. My first pass queried `fmv_snapshots`/`sales` for all five and got NULL
and 0 for Pinnacle — which would have read as "Pinnacle is broken" and is simply the wrong table.
CLAUDE.md's schema note is what caught it.

## ⚠ The finding: accuracy tracks liquidity monotonically

Ordering the four `fmv_snapshots` collections by per-edition sales volume reproduces the accuracy
ordering exactly, with no inversions:

```
5.51 sales/edition/month -> 34.2%   (top shot)
1.69                     -> 22.7%   (all day)
0.17                     ->  0.0%   (golazos)
0.00                     ->  0.0%   (ufc)
```

**The ceiling on the headline metric is market depth, not the pricing code.** An edition with 0.17 sales
a month cannot reach a sales-based HIGH/MEDIUM no matter how good the estimator is — Golazos's best
non-ASK confidence is LOW, on a maximum of 12 sales in 30 days across its busiest edition.

⚠ **Stated as its limits require: this is 4 points and a consistent ordering, not a fitted law.** It is
strong enough to redirect effort and not strong enough to quantify. It does **not** say the estimator is
good; it says the estimator is not what is capping Golazos and UFC.

## ⚠ UFC Strike is a DEAD MARKET, and the shape proves it rather than asserting it

`ufc_strike` has **0 sales in 30 days** and its **last sale was 2026-05-13** — over three months ago.
The tempting reading is a broken indexer. It is not, and the monthly shape is the control:

| month | sales | avg price |
|---|---:|---:|
| 2026-01 | 265 | $3.86 |
| 2026-02 | 165 | $3.14 |
| 2026-03 | 48 | $1.83 |
| 2026-04 | 57 | $1.03 |
| 2026-05 | 5 | $0.68 |
| since | **0** | — |

**Volume and price decay together over five months.** An ingestion break is a *cliff at full price*;
this is a market dying. So UFC's `STALE`/`NO_DATA` population is the **honest** answer, and the 99-hour-old
FMV write is a consequence of having nothing to recompute, not a pipeline failure. ⚠ I nearly filed
"UFC recalc is broken" off the 99-hour staleness alone.

## ⚠ But UFC prices ZERO editions at ASK_ONLY, and that IS a defect — it links to the dormant-walker filing

Golazos, with the same dead-ish market, still prices **110 of 575** editions at `ASK_ONLY`. UFC prices
**0 of 518**. The reason is upstream of pricing entirely:

| | active listings | newest listing | listings indexer runs (all time) | ASK_ONLY prices |
|---|---:|---|---:|---:|
| golazos | **434** | 2026-08-20 | 2,181 | **110** |
| ufc | **0** | never | **0** | **0** |

`ufc-listings-indexer` is one of the four walkers in the 2026-08-21T1701Z filing that **have never run
since being created (2026-05-17)**. RPC has never ingested a single UFC listing. That filing asked
whether the dormant routes were worth wiring; **this is the answer for one of them** — wiring it would
move 518 editions from "no price at all" to an honest ask-based price, even on a dead market.

## What this means for the gate (decisions, not actions — none taken)

1. **The metric cannot move much by improving the estimator on thin editions.** Two of five collections
   are liquidity-capped at zero. Effort spent on better math for sparse editions buys nothing.
2. **`nfl_all_day` is where algorithmic headroom most plausibly exists** — 1.69 sales/edition/month is
   real liquidity, and 22.7% is the lowest return on it of any live collection. That is where to look
   first. ⚠ Stated as a place to look, not a conclusion: I did not audit the confidence thresholds.
3. **ASK coverage is the only lever for illiquid collections**, and it is unevenly wired — Golazos has
   it, UFC has never had it.
4. **UFC Strike is a deprecation candidate, not an investment one.** Zero sales for three months, zero
   listings ever, 518 editions carried through every cross-collection board query. The honest options
   are to wire the listings indexer for ASK-only pricing, or to stop carrying the collection. ⚠ Note it
   is currently `is_active = true` and appears in public surfaces.
5. **The metric should be tracked, not re-derived.** There is no view for the number the roadmap calls
   the headline. The exact SQL used here is below so the next reading is comparable rather than
   re-invented.

## The query, so the next measurement is comparable

⚠ Run it in the healthy window (20:00–00:00Z). The per-collection LATERAL is index-backed
(`fmv_snapshots_<year>_collection_id_edition_id_computed_at_idx`, partition-pruned) and cheap per row,
but it does one probe per edition, so it is ~20k probes for Top Shot. Do **not** substitute
`fmv_current` — that view is a `DISTINCT ON (edition_id)` sort over the whole partitioned table.

```sql
-- One collection at a time; scoped so each probe uses the partition index.
SELECT f.confidence::text AS confidence, count(*) AS editions
FROM editions e
JOIN LATERAL (
  SELECT fs.confidence FROM fmv_snapshots fs
  WHERE fs.collection_id = '<collection uuid>' AND fs.edition_id = e.id
  ORDER BY fs.computed_at DESC LIMIT 1
) f ON true
WHERE e.collection_id = '<collection uuid>'
GROUP BY 1;

-- Pinnacle is a DIFFERENT table — render-keyed, not in fmv_snapshots:
SELECT fmv_confidence::text, count(*) FROM pinnacle_catalog
WHERE fmv_confidence IS NOT NULL GROUP BY 1;
```

## Not claimed

Nothing here says 31.3% is good or bad against competitors — the roadmap's bar is *"beats the sites
collectors already use"*, and I did not measure any competitor. It says what the number is, that it is
liquidity-bound for 2 of 5 collections, and where the remaining headroom plausibly sits.
