# Diagnosis — NFL All Day FMV cold tail: honestly cold, not a coverage bug (2026-06-29, Cowork)

Addresses the cross-thread ask: "profile the AllDay FMV cold tail (NO_DATA + STALE) — do these editions have a live ask source that could floor them ASK_ONLY like the TS parallel floor?" Conclusion: **no untapped source; the tail is genuinely cold.** Pricing-pipeline review-gate respected — only the existing approved fn was run; the one cadence idea is proposed, not shipped.

## What the cold tail actually is (measured)

Cold tail = 1,765 editions (NO_DATA 1,415 + STALE 349 at diagnosis time). Breakdown:
- **By tier it's high-end, not junk:** LEGENDARY 613 + ULTIMATE 410 + RARE 564 = 1,587; only 178 COMMON/UNCOMMON. These are *scarce* editions that list/trade rarely — thin market, not low quality.
- **~1,530 of 1,765 were never listed** on the indexer; **~1,241 never traded at all.** For those there is no ask and no sale to derive any honest FMV from — NO_DATA is the correct answer (same conclusion as the TS "troll asks" work: never fabricate ASK_ONLY on zero-sale/zero-listing editions).

## Is there an untapped ask source? No.

`cached_listings_v2` (the source CC's `refresh_allday_ask_fmv_from_listings` already uses) **is the comprehensive AllDay ask feed** — its `source` values for AllDay are `direct` (36,980) + `direct_v1` (18,349) + `direct_v2` (3,851) + `flowty` (1,431, dead). "direct" *is* the native Dapper marketplace; there is no separate dapper.market/Atlas ask feed for AllDay to add. `badge_editions.low_ask` is NULL for AllDay (TS-only feed). `edition_offers` is bid-side (offers to buy ≠ asks), wrong sign for an ASK floor. So CC's refresh already taps the only ask source, exhaustively.

## The only real gap: refresh latency (addressed in-lane)

66 cold-tail editions had a *live* ask but were still cold — pure timing: `refresh_allday_ask_fmv_from_listings` runs **daily** (last 17:05 UTC), so editions listed since the last run sit at NO_DATA/STALE for up to ~24h. I ran the existing approved fn (idempotent — exactly what the daily cron does): **rescued 55 → ASK_ONLY** (STALE 349→295, ASK_ONLY 1,208→1,258). Security invariants 0.

## Proposal (review-gated — NOT shipped)

**Bump the `allday-listing-ask-fmv` cron daily → every ~6h** so fresh high-tier listings floor within hours, not a day. It changes cadence only, not pricing logic (same fn, same ask×0.90), cost-flat, one-line revert (`cron.alter_job`/reschedule). Left to CC/Trevor since CC owns the cron and the prompt review-gates pricing-adjacent changes. Marginal benefit on a low-traffic pre-launch collection, so low priority.

## Bottom line
AllDay FMV is now at TS-parity *given the data*: corrected pack EV (shipped), FMV freshness from the sole ask source (shipped, exhaustive), realized-pull reality-check (shipped this session, ~99% coverage). The residual NO_DATA is a **thin-market reality** (scarce high-tier editions nobody is listing or selling), not a fixable coverage hole. The honest lever is more sales/listings, which can't be manufactured — don't fabricate floors. Recommend **closing cold-tail FMV hardening as a non-lever** beyond the cadence tweak above.
