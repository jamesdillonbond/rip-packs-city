# Daytime health monitor — inbox candidates (2026-09-30 ~00:13Z / 2026-09-29 ~5:13 PM PT)

Read-only daytime sweep. **Core health GREEN:** security 4/4 [] · trust 38/38 ok, 0 breaches · sentinel (TS edition-writer leak 48h) 0 · pg_cron failures [] · detect_stalled_pipelines 1 (known, below) · all artifact-backing relations/functions present (11 artifacts, no daytime schema-change breakage) · 8 recent Vercel deploys all READY (Trevor actively shipping ~5 PM PT). NOT in a saturation spell (rpc_ops_snapshot returned fast, pg_cron clean, no timeouts) — causal reads below are safe. Two LOW / known candidates, neither a code ship.

## 1. [LOW / visibility] TS active-listings feeder dark ~25.8h — Windows Task Scheduler task may need re-arming
- **Source:** rpc_ops_snapshot stalled_pipelines + pipeline_alerts -> `topshot-active-listings-ingest`, last_run 2026-09-28T22:13Z, silent 1551 min (threshold 900; medium/visibility-only, does not page).
- **Context:** the load-bearing feeder is a RESIDENTIAL Windows Task Scheduler task on Trevor's box (attribute by atlas_calls>0, not schedule minute). >900 min gap = that task hasn't fired in over a day. Trevor's box is demonstrably UP right now (8 Vercel deploys in the 35 min before this run), so this is the task not firing, not the box being off.
- **Risk read:** none to the DB / no data loss. Blast radius = the TS active-listings board / Pack Sniper underpriced-#1s feed is ~1 day stale.
- **Suggested action (Trevor, not code):** confirm the `-StartWhenAvailable` TS active-listings task is enabled and re-run it. If it keeps recurring, the durable fix named in the watchlist is box availability or a 2nd datacenter-independent feeder — NOT raising 900 (that re-hides the detection).

## 2. [LOW / watch] atlas-editions upstream 403 — 5 of 282 sets behind a walk >6h (oldest 9h)
- **Source:** rpc_ops_snapshot pipeline_alerts -> `atlas-editions-upstream-403` (attributed via net._http_response |><| atlas_edition_requests). 96/480 dispatches 403 in 2h (20%, Cloudflare challenge — normal base rate). The row's own escalation condition (sets-behind non-zero) is currently MET.
- **Risk read:** no rows lost — atlas_editions_drain() RAISEs on non-200 and does NOT advance next_offset, so behind sets re-walk next cycle (~75 min). Concern is only whether the retry keeps pace; 5/282 is small, oldest 9h.
- **Suggested action (night pass — watch, not a fix):** re-check sets-behind next pass. If it GROWS or oldest exceeds ~12h, the retry isn't keeping up and catalog freshness is at risk; otherwise self-heals, needs nothing.

_Not logged (known/by-design, seen and cleared): pg_net_http_429 (high, endpoint-unknown standing ambiguity row) · atlas-market 403 (info, fresh, last drain 00:03Z) · panini-collector-walk usernotfound (being managed via 09-29 target-config edits) · unmapped-sales-nfl_all_day (info, non-stationary drain) · flow-rest-moment-moved-400 (info, designed) · pinnacle-pack-openers 48 fails/24h (NOW green every run, recovered — Pinnacle pre-spork pricing ship not regressing it)._
