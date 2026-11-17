# #70 ANSWERED with an independent index — the All Day decline is REAL, our listing ingest is EXACT, and we are missing the entire accepted-offer lane (~24% of sales) — 2026-09-11T10:30Z

Filed by Claude Code on Trevor's box (interactive, 03:30 PT). #70 said the next probe *"is upstream,
not another pipeline read"* and that an upstream coverage change *"looks identical from inside and
was not measured."* **It is now measured**, against Dune's `flow.cadence_events` — an index built
from the chain, wholly independent of this estate's pipelines.

---

## 1. The decline is REAL, and our listing ingest is essentially perfect

Counting `NFTStorefront(V2).ListingCompleted` where `nftType = A.e4cf4bdc1751c65d.AllDay.NFT` **and
`purchased = true`** (so cancellations are excluded; they are numerous — 09-07 had 629 cancels
against 272 purchases), per day, against RPC's own `sales`:

| day | Dune purchased | RPC sales | day | Dune | RPC |
|---|---:|---:|---|---:|---:|
| 08-13 | 398 | **398** | 09-01 | 104 | **104** |
| 08-15 | 436 | **436** | 09-03 | 66 | **66** |
| 08-17 | 841 | **841** | 09-05 | 226 | **226** |
| 08-22 | 491 | **491** | 09-06 | 49 | **49** |
| 08-25 | 83 | **83** | 09-08 | 159 | **159** |
| 08-28 | 89 | **89** | 09-09 | 269 | **269** |
| 08-31 | 146 | **146** | 09-10 | 984 | **984** |

⭐ **27 of 30 days agree EXACTLY.** The three that do not: 08-12 (379 vs 277 — the RPC side is a
partial day, the window opened mid-day) and 08-14 / 08-18, off by **2 rows each**.

✅ **So the coverage hypothesis is REFUTED for the listing path.** On-chain purchased listings fell
from a ~400/day band (08-12→08-24) to ~150/day (08-25→09-09) — **the market halved, we did not stop
seeing it.** ⭐ **And it has turned:** 09-10 printed **984**, the highest since 08-17, on NFL kickoff.

## 2. …but we are missing a whole SALE TYPE, and Top Shot already captures it

⛔ The exact agreement above is itself the tell: if we matched the listing path perfectly, then
anything else is **absent**. `OffersV2.OfferCompleted` (`0xb8ea91944fd51c43`) with
`nftType = AllDay.NFT` and `purchased = true`:

| day | fills | day | fills | day | fills |
|---|---:|---|---:|---|---:|
| 08-25 | 144 | 09-01 | 39 | 09-06 | 51 |
| 08-26 | 98 | 09-02 | 45 | 09-07 | 16 |
| 08-27 | 59 | 09-03 | 90 | 09-08 | 46 |
| 08-28 | 51 | 09-04 | 56 | 09-09 | 71 |
| 08-30 | 56 | 09-05 | 164 | 09-10 | 79 |

**1,110 accepted-offer fills over 08-25 → 09-10**, against **3,581** sales we captured in the same
window — so we are missing **~31% of what we record, ~24% of true All Day sale volume**, and it is
not noise: it is present every single day.

🚨 **TOP SHOT ALREADY HAS THIS LANE AND ALL DAY DOES NOT.** Sources over the last 14 days:

```
nba_top_shot   onchain             15,059
nba_top_shot   offer_fill           9,260   ← the lane
nba_top_shot   atlas                4,538
nfl_all_day    onchain_dapper_v2    2,537
nfl_all_day    onchain_dapper_v1      669
                                    (no offer_fill row exists for All Day)
```

⭐ **The indexer is not missing — its scope is.** This repo already records that
`0xb8ea91944fd51c43` **"serves AllDay + TopShot"**; the OffersV2 lane was built and pointed at Top
Shot only. **This is a scope widening of a working lane, not new machinery** — the same shape as the
2026-07-19 counterparty widening (`nba_top_shot → (nba_top_shot, nfl_all_day, ufc_strike)`).

## 3. Why this matters for go-live M2

M2 is All Day's HIGH/MEDIUM FMV share, and confidence is driven by **sales count per edition**
(`MIN_SALES_30D_MEDIUM = 5`; ask corroboration lifts LOW→MEDIUM at 3). **Systematically dropping ~24%
of sales — an entire sale type, spread across editions — depresses that share by construction.**

⚠ **Stated as direction and input size, NOT as a quantified M2 delta.** How much M2 moves depends on
how those 1,110 fills distribute across editions and how many sit near a threshold — **that is
measurable and has not been measured.** Do not quote a predicted M2 number off this filing; the
honest claim is that a known, sized, systematic omission exists on the metric's primary input.

## Suggested actions

1. **Widen the OffersV2 offer-fill lane to All Day** (and check UFC/Golazos while there). The lane
   exists, the contract already serves All Day, and Top Shot's `offer_fill` source is the template.
   ⭐ **Highest-value item here**: it is additive, it is the go-live gate's own input, and it is a
   scope change to working code rather than a new pipeline.
2. **Then re-measure M2** and report the delta — that is the honest way to size step 1, and it turns
   this filing's directional claim into a number.
3. **Backfill historical All Day offer-fills** if step 1 lands. ⛔ Bulk writes to `sales` — Trevor's
   call, same class as #83.

**Method / limits, so this can be re-run or refuted.** Dune `flow.cadence_events`, partition-filtered
on `block_date`; event types read from the chain, not assumed; `purchased` and `nftType` parsed from
the event `data` JSON. Total cost **1.9 credits of 2,500**. ⚠ It counts EVENTS, so a multi-moment
transaction contributes one row per moment — which is why it is comparable to `sales` rows rather
than to transactions. ⚠ It does not cover any sale path that emits neither event type; the exact
27-of-30 agreement is the evidence that those two plus offers are the whole picture, not an
assumption.

---

## 4. ADDENDUM (same session, ~03:40 PT): the M2 impact is now MEASURED, and it is MUCH SMALLER than §3 implies

§3 deliberately refused to quote a number. Having now measured one, the honest headline is a
**correction to the impression this filing otherwise leaves**: *"we are missing ~24% of sales"* sounds
like a large M2 lever. **It is not.**

**Method.** Pulled all 2,190 All Day offer-fills for 08-12 → 09-11 with their `nftId` (Dune, 1.45
credits). ⚠ **There is no All Day NFT→edition catalog in this estate** — `moments` holds **zero** All
Day rows (it is Top Shot only) and `wallet_moments_cache` keys on `(edition_key, serial)` with no
`nft_id` column — so the only mapping available to me is **prior sales**. That keys **450 of 2,190
fills (21%) onto 325 editions**; the other 1,740 are NFTs this estate has never seen sell.

**Result on the mappable subset** (current 30-day sale counts from `sales_2026`, confidence from
`fmv_current`):

| | editions |
|---|---:|
| touched by a mappable fill | 325 |
| already HIGH/MEDIUM (fills change nothing) | 69 |
| not yet HIGH/MEDIUM | 256 |
| **would cross the 5-sale MEDIUM threshold** | **9** |
| would cross the 3-sale ask-corroboration threshold | 36 |

**9 to 36 editions of a 6,190 denominator = +0.15 to +0.58 points of M2.**

⚠ **A naive ×4.87 scale-up to all 2,190 fills gives +0.7 to +2.8 points — and that is an UPPER BOUND,
not a central estimate.** The mappable subset is **biased toward editions that have already traded**
(that is literally how they were mappable), and those sit nearer a threshold. The 1,740 unmappable
fills are disproportionately in colder editions, where one added sale moves 0→1 and crosses nothing.
**So the true figure is below the naive scaling, probably well below.**

⭐ **Against the live gap this matters: M2 reads 28.8% against a 30% bar — 1.2 points.** The measured
lower bound (+0.15 to +0.58) **does not close it**; the upper bound might. **So the offer-fill lane is
worth shipping on data-completeness grounds and as a contributor, but it should NOT be sold as the
fix for M2**, and anyone planning against it should use the measured lower bound.

⛔ **AND THE FIX IS BIGGER THAN "WIDEN THE LANE", which §3 understated.** A real ingest lane would
resolve each NFT's edition **from the chain**, as `onchain_dapper_v1/v2` already do — so the 79%
unmappable figure is an artifact of MY method, not a property of the fix. **But it does show there is
no All Day NFT→edition catalog to lean on**, which is the same gap that leaves
`unmapped-sales-nfl_all_day` sitting at ~33,835 open rows. **Scope the lane with its resolver, or it
will write sales it cannot key.**
