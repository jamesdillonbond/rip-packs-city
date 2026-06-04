# FMV held-wallet LOW — corrected root cause (2026-06-04, Claude Code)

Investigation triggered by `docs/...FMV confidence strategy` (the L1–L7 plan). I ran live read-only
diagnostics against the 6 beta/watch wallets' held Top Shot editions and the result **overturns
several premises in that doc.** Nothing pricing-related was shipped — this is the evidence + a
re-sequenced plan for Trevor's sign-off (FMV logic stays a product-judgment gate).

## TL;DR
The held-TS LOW bucket is **not** mainly "tight editions one ask-corroboration step from MEDIUM."
It splits into three very different populations, and the two biggest levers are **not** the doc's L1/L2:

| Cause | Held LOW (raw ≥5 30d sales) | Nature | Right lever |
|---|---|---|---|
| **A. Serial-residual gate demotion** | ~434 (snap_n>0, LOW, 1.7.0) | Working-as-designed conservative demotion: ≥7 sales but log-residual SD ≥0.35 | L1 ask-corroboration (rescues the subset whose live ask agrees) |
| **B. `snap_n=0` GQL fossils re-stamped by Step 6** | ~607 (snap_n=0, LOW, 1.7.0) | **Bug**: crude GQL-writer LOW rows kept alive as fake-fresh `1.7.0` | Re-price from sales / stop fossil propagation (freshness bug, NOT a model change) |
| Genuinely thin | 3,183 (1–4 sales) + 1,105 (0 sales) | Honest LOW | L5 presentation / L6 |

## Premises corrected

1. **L2 "the serial-residual HIGH/MED gate may not be wired into live recalc" — FALSE.**
   `app/api/fmv-recalc/route.ts:535` calls `escalateConfidence(baseConfidence, sales.length, prices, serials)`
   with the serials array (`serials` built at :527, `serial_number` selected at :270, F3 serial>circ
   drop at :418). The gate is wired and is *actively demoting* well-traded-but-dispersed editions to LOW.
   It is not a wiring bug.

2. **"Only 7 of 5,390 snapshots are >24h old → throughput/staleness is not the bottleneck" — misleading.**
   The timestamps are fresh because **Step 6 (the daily force_stale "freshness touch") and the GQL
   writer re-stamp rows daily** — but those are fresh *copies of a stale crude-GQL LOW*, not fresh
   Step-1 sales recomputes. Freshness-of-timestamp ≠ freshness-of-computation. Example: edition `219:7409`
   (Chaz Lanier "Rookie Debut", circ 1149) has **207 sales in 30d**, yet its latest snapshot is
   `1.7.0 / LOW / wap=$6.76 / sales_count_30d=0 / days_since_sale=11 (frozen)` re-stamped once per day
   since ~2026-05-28.

3. **"CV<0.40 editions should be MED/HIGH" — apples-to-oranges.** The doc's CV is *linear* (stddev/mean);
   the gate threshold (0.20 HIGH / 0.35 MEDIUM) is the SD of **log-price residuals**. A linear CV of 0.40
   ≈ log-SD ~0.39, which sits *above* the 0.35 MEDIUM gate. So many "CV<0.40" editions are correctly LOW
   under the current model, not mislabeled.

## The Cause-B bug (the highest-leverage, lowest-risk finding)

Two writers + the stale-touch interact to pin actively-traded editions at LOW:

- **`upsert_topshot_marketplace_fmv`** (called by `topshot-fmv-populate`, the GQL marketplace path)
  writes `algo_version='topshot-gql-v1'`, `confidence=LOW` (off the crude GQL `average_price`, not the
  sales-table WAP), and **`sales_count_30d=0`**, for any edition whose latest snapshot is not already
  HIGH/MEDIUM (gate: `latest.conf NOT IN ('HIGH','MEDIUM')`).
- **Step 6** (`fmv-recalc` force_stale, runs daily via the "RPC FMV Recalc Force Stale" cron) reads the
  *latest* snapshot per edition (any algo) and re-inserts it with **`algo_version` hardcoded to `'1.7.0'`**
  (route.ts:926) while preserving `sales_count_30d` (:924) — so a GQL-origin `snap_n=0` LOW row becomes a
  fake-fresh `1.7.0` row that wins "latest computed_at wins" forever.

Net: ~607 held editions (and presumably a large multiple platform-wide) with abundant recent sales are
frozen at a stale crude-GQL LOW with `sales_count_30d=0`. This also breaks the doc's L5 idea ("show $X from
N sales") because N is recorded as 0 on these rows.

**Why L1 still sticks despite this:** once an edition reaches MEDIUM/HIGH, the GQL writer's
`NOT IN (HIGH,MEDIUM)` gate spares it. So any change that legitimately lifts these to MEDIUM (re-price
from sales, or ask-corroboration) is self-protecting going forward.

## Live numbers (6 beta/watch wallets, TS held editions)

- Latest-snapshot confidence: LOW 5,390 / MEDIUM 565 / NO_DATA 487 / ASK_ONLY 450 / HIGH 230 / STALE 143 / SALES_ONLY 6.
- Of the 5,390 LOW: 1,102 have ≥5 raw 30d sales, 3,183 have 1–4, 1,105 have 0.
- Of the 1,102 LOW-with-≥5-sales: **607 snap_n=0 (Cause B), ~434 snap_n>0 (Cause A), 819 have ≥7 sales (HIGH-gate eligible).**
- Only 2 of the 609 snap_n=0 bucket are serial>circ (F3 is **not** the cause); 561 have all serials within circulation.
- 1,027 of 1,101 had a real Step-1 (snap_n>0) write in the last 14d — so it is **not** primarily cursor starvation.

## Re-sequenced recommendation (for sign-off; nothing shipped)

1. **Fix Cause B first (biggest + safest lever, and it's a bug not a model change).** Make `fmv-recalc`
   re-price these from the sales table and prevent Step 6 from propagating a `sales_count_30d=0` row over
   an edition that has recent in-window sales. Options: (a) Step 6 skips re-stamping when the source row's
   `sales_count_30d=0` AND the edition has ≥MEDIUM-floor sales in `sales` (let Step 1 own it); (b) the GQL
   writer stops writing `sales_count_30d=0`/LOW for editions with real recent sales (defer to recalc);
   (c) a one-shot Step-1 recompute over held/actively-traded editions (L4) to clear the fossils. Validate
   before/after with `v_tracked_wallet_fmv_confidence` and `v_fmv_sanity_flags`.
2. **Then L1 ask-corroboration for Cause A** — `escalateConfidence` takes the live ask
   (`edition_offers.low_ask`, joined by `collection_id`+`external_id`; the column exists). When ≥3 qualifying
   sales and the WAP/median is within ~20–25% of the ask, raise one step; diverge → stay LOW. This rescues
   the genuinely-dispersed-but-ask-confirmed subset of the 434. Magnitude is **smaller** than the doc's
   11%→39% projection (that projection assumed the whole LOW-with-sales bucket was Cause-A-like; ~55% of it
   is actually Cause B).
3. **L3 accuracy gates** already partly shipped (F3 serial>circ in recalc; 8:62 re-map). Keep.
4. **L5 presentation** — only meaningful after Cause B is fixed (else N=0 on the fossils).

## Pointers
- `app/api/fmv-recalc/route.ts` — Step 1 :255–576 (sales pricing + confidence), Step 5b :790–846
  (historical fallback), **Step 6 :851–950 (stale touch — the re-stamp, :926 hardcodes algo_version)**.
- `lib/fmv-confidence.ts` — `escalateConfidence` / `serialResidualDispersion` (gate; correctly wired).
- `lib/fmv-phantom-guard.ts` — `applyAllFmvGuards` (never demotes MEDIUM→LOW; stale guard needs sales_count_30d=0).
- `upsert_topshot_marketplace_fmv` (DB function) — the GQL writer; `algo_version='topshot-gql-v1'`, writes `sales_count_30d=0`.
- Monitoring: `v_tracked_wallet_fmv_confidence` (shipped this session by the strategy pass), `v_fmv_sanity_flags`.
