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
