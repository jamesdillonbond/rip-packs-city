# Daytime monitor — Top Shot Atlas lanes STILL DARK ~10h (502), escalation of 2026-10-27T1809Z

**Filed:** 2026-10-28 ~03:12Z (daytime health monitor) · **Priority: HIGH (freshness) / upstream**

## What
All three Top Shot Atlas ingestion lanes remain fully dark — this is the SAME incident already filed in
`2026-10-27T1809Z-atlas-upstream-502-all-three-topshot-lanes-frozen.md`, but it has **NOT recovered**. That
filing said "verify recovery"; the answer is **no** — it is now ~10h and still dark.

- `atlas-market-feed`, `atlas-editions-refresh`, `topshot-pack-supply-atlas`: last_ok all 2026-10-27 17:03–17:04Z;
  0 ok / 0 rows written across 180–360 runs each over the last 6h (lanes are firing, doing no work).
- Failure mode is still **upstream 502 (origin-down)**, not a Cloudflare 403 wall: on the market lane in the last
  3h, status 502 ×609 (newest 03:12Z) vs 403 ×39 (the usual base-rate minority).
- **Freshness is genuinely degraded, no fallback covering it:** newest Top Shot atlas market event last_seen 17:03Z
  (~10.1h), newest Top Shot sale ingested 16:54Z (~10.2h).

## Source
`rpc_ops_snapshot()` pipeline_alerts (403 arms + three `running_but_not_succeeding` arms) · `pipeline_runs` 6h
roll-up · `net._http_response ⋈ topshot_atlas_market_requests` status split · `topshot_atlas_market_events` /
`sales_market` freshness. Positive control clean (io_wait 2 / active 4) — **not** a DB saturation spell; cause
assertion is safe.

## Risk read
Correctness-safe (each failed page is re-walked, nothing lost per the arm text), but Top Shot — the flagship
collection — has had **no new market/edition/sale data for ~10h**, so FMV is recomputing over a frozen input set.
A persistent 10h upstream 502 is well beyond a transient blip and beyond what the 18:09Z filing anticipated.

## Suggested action (night pass / Trevor — monitor is sense-only, did NOT act)
Upstream (TopShot origin) 502 — not an RPC regression and not revert-able. Either the origin recovers on its own,
or kick the home-machine Task Scheduler fallback lane (per ledger: home-machine egress is the standing
workaround for the datacenter-egress Atlas failure class). Re-verify freshness recovers (newest market event /
sale timestamps advance past 17:03Z) once a lane lands a 200. Do NOT re-walk/probe heavily while 502.


## ✅ DISPOSITIONED 2026-10-27 ~9:00 PM PT (Cowork cloud) — upstream maintenance, nothing to fix on our side
Measured: `https://nbatopshot.com/` and `https://nflallday.com/` both 307 to `maintenance.<site>/` ("Down for maintenance"), whose `status.json` reads `{"state": "maintenance"}`; `public-api.nbatopshot.com/graphql` answers 530. The last Top Shot sale on record is 9:29 AM PT and the last All Day sale 8:33 AM PT — the marketplaces themselves are closed, so the 502s are Dapper's origin, not an egress block. **The home-machine fallback suggested above would not help** (it routes around a Cloudflare challenge, not a closed platform). Users are told: `collection_config` marketplace status is `degraded` on Top Shot / All Day / Pinnacle / Golazos (`20261027192917`), `/api/marketplace-status` serves the maintenance note, and the banner renders on `/nba-top-shot` and `/nfl-all-day/sniper` at 390 px (Playwright, ~8:55 PM PT). `restore_dapper_maintenance_notice()` (pg_cron, every 10 min, active) lifts the notice once 2+ atlas-market-feed runs succeed in 20 min, backstop 12 AM PT 10-30. Re-verify only that freshness advances past 10:03 AM PT once Dapper returns.
