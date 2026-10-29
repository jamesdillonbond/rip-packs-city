# Daytime monitor — Top Shot listing lanes still dark after the Dapper maintenance notice auto-lifted

**Status: 🟢 infra GREEN · WATCH / LOW · read-only, not a spell (io_wait 0 / active 3).**

## Context — the Dapper outage has RECOVERED
The 10-27/10-28 Dapper upstream-maintenance outage (inbox `2026-10-27T1809Z` + `2026-10-28T0312Z`, both DISPOSITIONED) has cleared:
- `collection_config.metadata.marketplace.status` = **healthy** on nba_top_shot / nfl_all_day / disney_pinnacle / laliga_golazos (ufc_strike = shutdown, by-design). The maintenance-notice auto-lift fired correctly (needs 2+ ok atlas-market-feed in 20 min — atlas-market-feed ok_3h=55, last ok 00:07Z).
- Atlas lanes back: atlas-editions-refresh last ok 00:09Z (67 ok / 23 fail / 3h), atlas-market-feed 00:07Z (55/35), topshot-pack-supply-atlas 00:10Z (126/54), topshot-sales-indexer 00:03Z (9 ok / 0 fail / 3h).
- The CRITICAL `topshot_sales` snapshot alert ("0 sales, cursor 169309818") is this outage clearing, **not a new break** — the sales-indexer runs clean; 0 TS sales in 6h is expected (marketplace was in maintenance; sales resume as trading reopens).

## The delta worth watching
Two Top Shot listing lanes have NOT resumed as of this tick:
- **topshot-listing-cache** — firing every 20 min but 100% failing; last ok **2026-10-28 04:15Z (~20h)**. Every run: `sweep incomplete: page 0 (offset 0) returned HTTP 500 — stale purge skipped, cache may hold delisted rows`. Feeds cached_listings → badge_editions.low_ask → fmv-recalc ASK_ONLY. max_silent_minutes=360 but it IS firing, so `detect_stalled_pipelines()` + the cadence arm stay green; only `rpc_ops_snapshot()`'s running_but_not_succeeding arm sees it (medium).
- **topshot-active-listings-ingest** — silent since **2026-10-28 16:13Z (~8h)**; max_silent_minutes=900 (15h) so WITHIN cadence (correctly not flagged by `detect_stalled_pipelines()`). Low-cadence lane; noted for completeness.

Both share the Top Shot/Dapper listing endpoint, so this is almost certainly outage-tail that should self-heal now the atlas lanes answer 200s again (which only resumed ~00:03–00:10Z, after listing-cache's last 23:55Z tick). But the notice has already flipped the UI to **healthy** while the TS listing feeder is still dark — so until listing-cache recovers, TS ASK_ONLY FMV + "Listed" asks drift stale behind a healthy banner.

## Suggested action (night pass — read-only confirm first)
1. Re-check both lanes get an ok tick. topshot-listing-cache fires :15/:35/:55; a post-00:10Z tick that STILL returns page-0 HTTP 500 means the listing endpoint is not Dapper-tail but a distinct break worth inspecting independently of the (now-healthy) atlas lanes.
2. If topshot-listing-cache stays 0-success while nba_top_shot shows healthy, weigh a listing-feeder staleness guard so "Listed" asks don't go stale behind a healthy marketplace banner.

Risk: **LOW** — read-only watch; no shippable action proposed, recovery expected on the next ticks. No causal claim on the HTTP 500 beyond "same upstream family as the outage"; verify, don't conclude.
