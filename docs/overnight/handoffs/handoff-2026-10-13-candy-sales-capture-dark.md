# Handoff — Candy (`candy_mlb`) sales capture has gone dark

**Date:** 2026-10-13 (~9:25 AM PT) · **Source:** Cowork weekly data-quality sweep (read-only) · **For:** Claude Code
**Priority:** P2 — a priced public collection's sale feed is silently not capturing; invisible to ok-rate alerting.
**Nothing was changed by the sweep.** This is an investigation brief, not a revert.

## Symptom

`v_rpc_trust_health` arm `candy_sales_stale_hours` = **37.0 h** (breach_at 30). It was **38/38 green on 2026-10-12** (yesterday's digest); today it is the only breach (37/38). The arm's own note: *"candy-sales-indexer stalled — the ONLY Candy price signal. 7d p95 inter-sale gap 0.91h, avg 0.30h."*

## What is and isn't happening

- **The indexer is NOT failing.** `candy-sales-indexer` over the last 24 h: **24/24 `ok=true`**, fires every 3 h, last run `2026-10-13 15:20:15Z`. The `-heartbeat` companion is also 24/24 ok.
- **Each run still reads the Magic Eden feed but finds no sales.** Every recent run's `extra`:
  `activities_seen: 500`, `sales_found: 0`, `sales_written: 0`, `asset_fetches: 0`, `me_key_present: false`, `budget_exhausted: false`, `duration_ms ~1000–1900`.
- **Last sale actually written:** run `2026-10-12 06:20:14Z` (`sales_found: 1`, `sales_written: 1`). Every run since has written 0.
- **The `sales` table confirms a hard cliff, not a market lull** (`collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'`, by `sold_at` day):

  | day | candy sales |
  |---|---|
  | 2026-10-09 | 203 |
  | 2026-10-10 | 91 |
  | 2026-10-11 | 19 |
  | 2026-10-12 | 1 |
  | 2026-10-13 | 0 |

  A market does not go from 200+/day to 0 in four days while the activity feed still returns a full 500-activity page every run. This reads as a **sale-event parse / feed-shape regression**: the indexer is reading activities but no longer recognising any of them as sales.

## Not the cause (ruled out or neutral)

- **`candy-opensea-sales-indexer`** is a *different* lane and is the known-shelved one (21/21 failing, `#58`, `OPENSEA_API_KEY` absent from Vercel, honest-degradation path). Do not confuse the two — the `candy-sales-indexer` (Magic Eden primary) is the one that went dark.
- **`me_key_present: false`** is on every run, but the lane wrote sales fine without a Magic Eden key before 10-11, so the absent key is not obviously the trigger. Worth confirming, not assuming.
- **FMV is unaffected** (`candy_fmv_stale_hours` 0.1 h, ok) because reprice runs off existing data — which is exactly why the public Candy price surface is quietly ageing toward its last real sale with no loud failure.

## Where to look

Root-cause is in **`app/api/candy-sales-indexer/route.ts`** (ingest/route logic — deliberately off-limits to the read-only sweep). Leading hypotheses, in order:

1. **Magic Eden changed the activity-feed JSON shape**, so the sale-event filter/parse no longer matches (the `sales_found: 0` against `activities_seen: 500` is the signature). Diff a live `/activities` payload against what the parser expects.
2. **The 500-activity window no longer reaches sale events** — if non-sale activity (listings/offers/delistings) surged, a fixed 500-row page can be all non-sales. Check whether pagination/`listType` needs to filter server-side for sales, or page deeper.
3. **An endpoint / `listType` / auth change** (possibly tied to the missing ME key) altered what the feed returns.

A live A/B against the Magic Eden endpoint is interactive work (route logic + live feed), not a code read — this handoff stops at the evidence.

## Diagnostics to re-run (read-only)

```sql
-- the breach
SELECT metric, value, breach_at, status FROM v_rpc_trust_health WHERE metric = 'candy_sales_stale_hours';

-- the indexer self-report
SELECT finished_at, ok, extra FROM pipeline_runs
WHERE pipeline = 'candy-sales-indexer' AND started_at > now()-interval '48 hours'
ORDER BY finished_at DESC LIMIT 12;

-- the sales cliff
SELECT date_trunc('day', sold_at)::date AS day, count(*)
FROM sales WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
  AND sold_at > now()-interval '14 days' GROUP BY 1 ORDER BY 1 DESC;
```

## Done when

`candy-sales-indexer.extra.sales_found` > 0 on a tick where Candy actually traded, and `candy_sales_stale_hours` falls back under 30 h.

**Revert:** n/a — the sweep shipped nothing.

---

## ✅ RESOLVED 2026-10-14 (~1:30 AM PT, Cowork cloud overnight, after Trevor said "do it all") — GENUINE MARKET FREEZE, not a capture regression

A live Magic Eden A/B settled this. `GET https://api-mainnet.magiceden.dev/v2/collections/2026_mlb_base_series_icons_candy_digital/activities?limit=200` (newest-first) returned: list 93 (newest 51.7h ago), delist 47 (48.2h), bid 31 (59.2h), **buyNow 29 (59.2h)**.

- `buyNow` is already in the indexer's `SALE_TYPES` (`route.ts:98/510`), so these sales WOULD be parsed. The newest `buyNow`'s `blockTime 1791775264` is **exactly our last captured sale, 10-12 03:21Z** — the indexer captured every sale and there have been none since. `sales_found: 0` is correct, not a miss.
- The newest activity of ANY type is ~48h old: nothing (sale, listing, bid, delist) has happened on this collection in ~2 days. The market is FROZEN. The sibling `candy-listings-indexer`'s `listings_found: 1390` is the standing listing BOOK (persists with zero new activity) — that is why it looked "healthy," not evidence of live trading.

**Conclusion:** the "sale-event parse / feed-shape regression" hypothesis in this brief is **DISPROVEN**. No change to `app/api/candy-sales-indexer/route.ts` is warranted — it is behaving correctly. The `candy_sales_stale_hours` breach is a frozen thin-market reading on a healthy pipeline. The only follow-up is a judgment-call retune of that trust arm to be indexer-health-aware (queued for Trevor). Full A/B in `docs/handoff-2026-10-14-overnight-pass.md`.
