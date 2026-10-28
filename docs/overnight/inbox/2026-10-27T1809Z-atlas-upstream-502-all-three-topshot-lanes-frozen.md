# Atlas upstream 502 — all three Top Shot Atlas lanes frozen since ~17:03Z

**Filed:** 2026-10-27 ~18:09Z (rpc-daytime-monitor)
**Priority:** HIGH (freshness) — but **upstream**, not a code defect. Sense-and-verify only.

## What
All three Top Shot Atlas-fed pipelines stopped landing successful runs **simultaneously at 17:03–17:04Z** and have failed every tick since (~64 min at filing):
- `atlas-market-feed` — last ok 17:03:00Z; 32 consecutive fails in 70 min; `atlas-market-upstream-403` arm escalated to **HIGH** (no successful drain in >30 min; newest market event 16:28Z).
- `atlas-editions-refresh` — last ok 17:03:00Z; "8 request(s) failed" every tick.
- `topshot-pack-supply-atlas` — last ok 17:04:00Z; "2 request(s) failed" every tick (298 fails/24h).

## Source
- `rpc_ops_snapshot()` pipeline_alerts (`atlas-market-upstream-403` severity=high; `atlas-market-feed` + `topshot-pack-supply-atlas` running_but_not_succeeding).
- `pipeline_runs` (last-ok per lane, all 17:03–17:04Z).
- `topshot_atlas_market_requests` last 30 min: **status_code 502 ×87** (`atlas 502 (): error code: 502`), 403 ×18 (last 403 at 17:58Z, tapering). The current block is the **502**, not the usual Cloudflare 403 challenge.

## Cause (stated with confidence — NOT a spell)
Positive control clean: `pg_stat_activity` io_wait=0, active=2, and `rpc_ops_snapshot()` returned instantly. So this is **not** DB saturation collateral. The dominant error is HTTP **502 "error code: 502"** — Cloudflare's own origin-unreachable page — meaning the Atlas origin (Top Shot's DistributionService/market backend) is down or unreachable behind Cloudflare. Three independent lanes failing at the same second = the shared Atlas origin, not three bugs.

## Risk read
LOW-to-MEDIUM blast radius **while it stays short**: the drains RAISE on non-200 and re-walk from offset 0, so **no rows are lost** and the lanes self-recover the moment Atlas returns 200. Top Shot market/sales/editions/pack-supply freshness is **frozen as of ~16:28Z** and will stay frozen until the origin recovers. If it persists for hours, Top Shot FMV/sales freshness (and anything downstream: sniper, deals, pack EV) begins to drift stale.

## Suggested action (night pass / Trevor)
1. **Verify recovery first** — re-check `max(started_at) FILTER (WHERE ok)` on the three lanes and `topshot_atlas_market_requests` status_code mix. If a 200 has landed since, this has self-cleared; **close with no code change** (upstream blip).
2. If still 502 at the overnight pass: this is a Top Shot/Cloudflare origin outage — **nothing to ship**. Note the TS freshness gap in metrics-latest drift and confirm the freshness arms are the ones carrying the signal (they are; working as designed).
3. Do **not** attempt a proxy/egress change on a 502 — it is origin-down, not a bot-challenge; the existing retry-from-offset-0 behavior is already the correct handling.

## Follow-up — 2026-10-27 ~11:20 AM PT (Claude Code cloud, session_014vX7Q6Cam1dR9kzm4npa2L)
Still down at 11:18 AM PT (all three lanes: last ok 10:03–10:04 AM PT). Wider than Atlas — **every Dapper-run marketplace stopped together, while the Flow chain kept working**:
- Newest sale per collection: Top Shot 9:29:09 AM PT, Disney Pinnacle 9:28:57 AM PT (12 s apart), NFL All Day 8:33 AM PT.
- `allday-sales-indexer` (on-chain): raw storefront events per 20-min tick ran 34–137 (V2 Dapper) / 18–195 (V1) all morning, then **exactly 0 from the 9:56 AM PT tick on**, for V1 and V2 alike. `blocks_scanned` stayed ~1,500/tick, so the cursor is advancing at the normal block rate.
- The chain answered: `allday-v1-listing-reverify` got HTTP 200 Cadence script results from rest-mainnet at 10:24 AM PT (654 listings verified live).
- Read: an upstream Dapper outage (the marketplace backend behind Atlas, Top Shot Market and the Dapper-wallet storefronts), not our ingest. Nothing to ship. Every lane is `ok`-honest (the indexers report 0 events found, not a fabricated count) and resumes by itself.
- **Night pass:** confirm the sales gap closes (newest `sales.sold_at` moves for Top Shot / All Day and `pinnacle_sales`). If Dapper backfills purchases made during the outage, the on-chain indexers pick them up from their cursors. The Atlas market feed re-walks from offset 0. Do not read today's 30-day sales counts or M2 as a regression while this window is in them.


## ✅ DISPOSITIONED 2026-10-27 ~9:00 PM PT (Cowork cloud) — upstream maintenance, nothing to fix on our side
Measured: `https://nbatopshot.com/` and `https://nflallday.com/` both 307 to `maintenance.<site>/` ("Down for maintenance"), whose `status.json` reads `{"state": "maintenance"}`; `public-api.nbatopshot.com/graphql` answers 530. The last Top Shot sale on record is 9:29 AM PT and the last All Day sale 8:33 AM PT — the marketplaces themselves are closed, so the 502s are Dapper's origin, not an egress block. **The home-machine fallback suggested above would not help** (it routes around a Cloudflare challenge, not a closed platform). Users are told: `collection_config` marketplace status is `degraded` on Top Shot / All Day / Pinnacle / Golazos (`20261027192917`), `/api/marketplace-status` serves the maintenance note, and the banner renders on `/nba-top-shot` and `/nfl-all-day/sniper` at 390 px (Playwright, ~8:55 PM PT). `restore_dapper_maintenance_notice()` (pg_cron, every 10 min, active) lifts the notice once 2+ atlas-market-feed runs succeed in 20 min, backstop 12 AM PT 10-30. Re-verify only that freshness advances past 10:03 AM PT once Dapper returns.
