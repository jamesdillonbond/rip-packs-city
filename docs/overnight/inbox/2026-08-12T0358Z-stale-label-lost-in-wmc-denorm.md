# Finding (CORRECTED) — the STALE label does not survive denormalization into wmc

**Filed 2026-08-11 ~21:00 PT / 2026-08-12 0358Z. Read-only investigation; nothing applied.**

Supersedes a cloud-session finding of the same name. **The core claim is CONFIRMED. Two of its
three supporting arguments are WRONG, and acting on them would have destroyed real data.** The
original text is preserved under "What the original got wrong" so the record shows what was claimed.

---

## CONFIRMED — the structural defect

`fmv_current` carries `confidence`. **`wallet_moments_cache` does not** — its only price column is
`fmv_usd` (24 columns verified; no confidence/quality field of any kind).

`populate_wmc_fmv_from_snapshots` is the writer, and its body **never references `confidence`**:

```sql
UPDATE public.wallet_moments_cache wmc
   SET fmv_usd = lf.fmv_usd
  FROM latest_fmv lf ...
```

So the staleness marker exists at the source and is **structurally unavailable at the point a
portfolio is summed**. This is by construction and is **platform-wide, not Golazos-specific**.

**It reaches a public render.** `get_wallet_collection_snapshot` — the RPC behind the anon-public
`/share/[wallet]` — returns per-collection `"fmv": 1227.48` with **no confidence field anywhere in
its output**. Verified live on `0x3795d42c0fc3a373`. Of the 10 portfolio-summing RPCs checked, **9
never mention confidence**; only the per-row `get_wallet_moments_with_fmv` does. **34 DB functions**
sum `wmc.fmv_usd` in total — that is the blast radius of any fix.

Golazos exposure, reproduced exactly: **177 copies / 10 wallets / 28 editions / $167,420.50 / 0
null denorms.** Materiality per wallet is high — the STALE cohort is **80%** of one wallet's whole
displayed Golazos total, and 60% / 43% / 40% / 39% of the next four.

---

## What the original got wrong

### 1. "the writer stopped on 08-07 — check whether it stalled" — NO. It is a 7-day OSCILLATION, and the guard is a NO-OP.

`apply_fmv_thin_sales_guard` is not a scheduled writer. It is a cleanup invoked from
`/api/fmv-recalc`, and it only writes when it caps something. The real loop, from 45 days of
snapshot history on those exact 28 editions:

| date | cold-tail-1.0 | thin-sales-guard-v3 |
|---|---|---|
| 08-07 | 18 eds STALE @ med **1015.75** | 18 eds STALE @ med **1015.75** |
| 08-06 | 10 eds STALE @ med **1168.50** | 10 eds STALE @ med **1168.50** |
| 07-31 | 13 eds STALE @ med **981.50** | 13 eds STALE @ med **981.50** |
| 07-30 | 15 eds STALE @ med **1312.50** | 15 eds STALE @ med **1312.50** |

Every ~7 days, in lockstep, at **identical values**. The mechanism:

1. `drain_fmv_cold_tail` only selects editions whose last snapshot is **older than 7 days**. These
   were written 08-06/08-07, so they are simply **not yet eligible** — nothing stalled.
2. When eligible, cold-tail finds 0 sales in 30d and no ask, and falls through to its historical
   median — `SELECT price_usd, sold_at FROM sales WHERE edition_id=... ORDER BY sold_at DESC LIMIT 30`,
   **with no time bound at all** — and writes it as `STALE`.
3. `apply_fmv_thin_sales_guard` then examines the row (fmv > 200, not ASK_ONLY, algo is
   `cold-tail-1.0` so not skipped), reaches the `stale_30d_no_ask` branch, and does
   **`v_cap := rec.fmv_usd`** — *the value unchanged* — with confidence `STALE`, which cold-tail had
   **already** set. It then writes a second, byte-identical row.

**So the guard changes nothing on this path.** It is pure write amplification plus a duplicate
`fmv_calibration_caps` entry, and it makes the cohort *look* like a guard artifact when the value
actually originates in cold-tail. ⚠ Do not "fix" the guard's frozen timestamp — it is not frozen,
and the guard is not the author of these numbers.

### 2. "$1,015 median vs a $0.85 live median — ~1,200× the market" — INVALID COMPARISON.

This pairs a count from one cohort with a price from a different one (the cross-instrument sampling
fallacy; same family as the D20 merged-denominator trap). Measured:

| cohort | tier | eds | median circulation | median FMV |
|---|---|---|---|---|
| the $167k cohort | LEGENDARY | 24 | **35** | $1,200.00 |
| the $167k cohort | RARE | 4 | 222 | $369.50 |
| the "$0.85" cohort | COMMON | 44 | **10,000** | $0.22 |
| the "$0.85" cohort | RARE | 31 | 375 | $0.85 |
| the "$0.85" cohort | UNCOMMON | 16 | 271 | $0.85 |

The $0.85 figure is COMMON/RARE at median circulation 10,000. The $167k cohort is **LEGENDARY at
median circulation 35**. And Golazos sales in the last 90 days: **COMMON 274, RARE 43, UNCOMMON 40,
LEGENDARY 0.** That tier has no live market whatsoever — which is exactly *why* it is STALE.

### 3. "do not re-price these" — RIGHT ANSWER, WRONG REASON, and the reason matters.

These are not fabricated. Spot-checked against real prints:

| player | tier | circ | FMV now | last real sale | last price |
|---|---|---|---|---|---|
| Karim Benzema | LEGENDARY | 45 | $4,500 | 2023-05-25 | **$6,500** |
| Pedri | LEGENDARY | 45 | $3,900 | 2023-05-29 | **$7,200** |
| Luka Modric | LEGENDARY | 45 | $2,400 | 2023-05-22 | $3,000 |
| Carles Puyol | LEGENDARY | 15 | $1,999 | 2023-05-24 | $1,999 |

Every one is a genuine historical median of genuine sales, and each sits **below** its own last
print. They are honest *last-known-values* on scarce assets with no current market. The original
called them absurd; they are defensible. **The price is not the defect — the missing label is.**

---

## The decision (Trevor's call — deliberately not taken)

The value is correct-as-last-known and correctly labeled STALE **at the source**. The only defect is
that the label is dropped at the denormalization boundary, so a portfolio total presents a
2-year-old print as current value with no marker. Options:

- **(A) Carry `confidence` onto wmc** alongside `fmv_usd`, so the 34 consumers *can* mark or withhold.
  Structurally correct and preserves all information. Cost: a column + backfill on a hot 2.2M-row
  table, plus threading it through consumers. ⚠ INCLUDE/predicate columns block HOT updates on a
  table the wallet walks write constantly — size this before committing.
- **(B) Null the denorm for STALE.** Cheap, but destroys the last-known-value and would render a
  LEGENDARY /45 as `—`, understating a real holding. Worse than the status quo for the owner.
- **(C) Disclose at the surface** — keep the number, mark the total as containing stale components.
  Cheapest honest option; matches the existing Panini "floor, not a census" precedent.

**Recommendation: A, then C.** B loses information we correctly have.

⚠ Whatever is chosen, **the ASK_ONLY cohort is the larger sibling and must be decided in the same
pass**: `ask_only_v2` carries **$135,271 across 2,964 copies** (max single copy $2,275) in Golazos
alone — ask-derived, also unlabeled in wmc. And `cold-tail-1.0 / NO_DATA` has **8 null denorms but
13 copies carrying $2,245**, max $449 — a price on an edition we explicitly say we have no data for.

## Not verified

- Platform-wide sizing across Top Shot / AllDay / UFC. Two attempts **timed out at 120s** against a
  saturated instance and I stopped rather than keep hammering prod. The *mechanism* is proven
  platform-wide from the writer's source; only the dollar total is Golazos-only.
- The original's closing claim that `golazos-shell-drain-stalled-2026-08-04` is a stale memory: **no
  such memory exists** (nor do `timeout-renders-as-a-false-zero` / `dense-low-fmv-is-honest`). They
  are forward-links, not stale entries. Nothing to retract.
