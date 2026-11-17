# Golazos is genuinely market-limited (measured ceiling ~2.8%), and the trust board's "stale" metric does not mean what its name implies

Claude Code, interactive, 2026-08-13 ~13:30 PT (20:30Z). **Read-only. No code, DB or prod change.**

Follow-on to the 08-13 headline re-measure ([roadmap §3.1](../../strategy/roadmap-2026-08-03.md), ledger
same date), which left Golazos as the clear laggard at **0.9%** HIGH/MEDIUM.

---

## Part 1 — the question worth asking, and the answer is "no"

The roadmap calls Golazos market-limited: *"0.7% HIGH/MEDIUM on 131 sales in 30 days is a collection
where the honest answer for nearly the whole catalogue is 'not enough trading to price this'."*

⚠ **That deserved re-testing rather than acceptance, because the plan made the SAME call about All Day
in the same table and was wrong there.** All Day was described as "different and worse… it looks alive…
that is a pipeline problem, not a market problem" — and indeed All Day has since gone **6.3% → 27.7%**.
If Golazos were mis-diagnosed the same way, there would be a comparable win sitting there.

**It is not. The roadmap's read is correct, and here is the number that settles it.**

Golazos sales in the trailing 30 days (`sales`, collection-scoped, index-backed):

| | |
|---|---:|
| sales (30 d) | **160** |
| distinct editions with ≥1 sale (30 d) | **103** |
| sales (7 d) | 14 |
| distinct editions (7 d) | 12 |

Sales-per-edition distribution over those 30 days:

| editions with… | n |
|---|---:|
| ≥1 sale | 103 |
| ≥2 sales | 31 |
| ≥3 sales | **14** |
| ≥5 sales | 3 |
| **most-traded single edition** | **6 sales** |

**The ceiling is the finding.** A defensible sales-backed confidence rule needs on the order of ≥3 sales
in the window. Only **14 of 575 editions** clear that — **~2.4% of the catalogue, ~2.8% of the 502
priced**. Golazos sits at 0.9% today, so the entire available headroom from a *perfect* confidence
assignment is roughly **+1.5 to +2 points**. There is no All-Day-shaped win here: the busiest Golazos
edition on the platform traded **six times in a month**.

**Live confidence distribution (latest snapshot per edition, 575 editions):**

| confidence | editions | % |
|---|---:|---:|
| STALE | 297 | 51.7 |
| ASK_ONLY | 109 | 19.0 |
| LOW | 87 | 15.1 |
| NO_DATA | 77 | 13.4 |
| **MEDIUM** | **5** | **0.9** |
| HIGH | 0 | 0.0 |

**Recommendation: do not open a Golazos FMV-accuracy workstream.** Record the ceiling instead, so the
0.9% stops reading as an unexplained failure next to Top Shot's 54.5%. The honest product answer for
Golazos is the label it already gets, and the roadmap already says so.

*(Method note: this also cross-validates the headline metric. All Day's live distribution is MEDIUM 25.4%
+ HIGH 2.2% = **27.6%**, against the precompute's **27.7%** — so `<coll>_fmv_high_med_share_pct` and a
hand-rolled DISTINCT-ON agree, and the 08-13 deltas can be trusted.)*

---

## Part 2 ⚠ — `<coll>_fmv_pct_stale_30d` and `confidence = 'STALE'` are DIFFERENT quantities, and they diverge hard

Both are on the trust surface. Both are called "stale". They measure different clocks:

| metric | what it actually measures | Golazos | All Day |
|---|---|---:|---:|
| `<coll>_fmv_pct_stale_30d` | share of editions whose **`computed_at`** is >30 d old — *did WE recompute?* | **0.0%** | **0.0%** |
| `confidence = 'STALE'` | the price is derived from **old market data** — *is the PRICE current?* | **51.7%** | **13.0%** |

**Golazos reads 0.0% stale by the board's metric while 51.7% of its prices carry a STALE label.** The
board's number is not wrong — it is a *pipeline-liveness* measure and it is doing its job (we recompute
everything, so it is 0.0 for every live collection, and UFC's **96.3%** correctly says recomputation has
stopped there). But its NAME invites the stronger reading, and the stronger reading is false.

⚠ **Consequence for anyone reading the board:** `golazos_fmv_pct_stale_30d = 0.0` looks like "Golazos
pricing is fresh". It means "we ran the recalc". The quantity an operator or collector actually cares
about — *how much of what we publish is based on old trades* — is **not on the board for any
collection**, and for Golazos it is the majority of the catalogue.

**Suggested (NOT taken — needs a migration, and the DB lane is a concurrent session's today):** add a
`<coll>_fmv_stale_confidence_share_pct` leg alongside the existing one in `rpc_thp_leg_fmv_coverage`.
The `elig` CTE there already has `confidence` in scope, so it is one more
`count(*) FILTER (WHERE confidence = 'STALE')` arm over the same pass — **no additional scan**. That is
the cheap half of the fix; whether it becomes a trust ARM with a breach threshold is a separate call,
and on current numbers Golazos would sit permanently red, which is the `ufc_fmv_stale_hours` trap this
repo has already paid for once. **Track-only first.**

⚠ Do not "fix" the naming by renaming `<coll>_fmv_pct_stale_30d` — it is consumed by
`v_rpc_trust_health` / `rpc_ops_snapshot()` and a rename is a breaking change for a metric that is
currently correct. Add the missing quantity; do not rename the existing one.
