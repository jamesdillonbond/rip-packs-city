# Daytime monitor candidate — 2026-10-03T00:06Z (evening tick, ~5:06 PM PT)

Monitor health: GREEN except the finding below. Security / structural-drift / trust all clean (trust 38/38 ok; yesterday's `panini_sale_feed_status` `public_board_slow_count` breach has CLEARED on its own — public_board_slow_count=0). Vercel last deploy READY (033a6f53); 24h runtime errors all chronic/known. This is the single new-to-inbox candidate this run.

## HIGH — pack-mint-probes: 20 s probe HTTP timeouts have WORSENED to near-total failure
- **Source:** pipeline `pack-mint-probes` — `rpc_ops_snapshot()` pipeline_alerts (failure_rate, medium) + pipeline_fails_24h (197 fails/24h, `upstream=0`); confirmed by hourly `pipeline_runs`.
- **What:** the dispatched probe HTTP calls hit the 20000 ms timeout. DNS ~1.5 ms + TCP/SSL ~47 ms are fast; the HTTP request/response runs out the full 20 s clock -> upstream/target slowness, not our wrapper (run wrapper ~481 ms avg).
- **Trend (WORSENING, not resolving):** onset ~2026-10-01 1:13 PM PT at ~45% (per 10-02 handoff). Hourly ok/fail over the last 14 h is now near-total failure — most hours 0 ok / 11-12 fail (14:00-17:00Z all 0/12; 22:00-23:00Z 1/11 and 0/12), only occasional 1-4 ok. 3-day rate reads 138/506 (27.3%) but that undercounts today; today's hourly is ~90-100% fail.
- **Containment:** still contained to the probe layer — `pack_ev_board_max_stale_days` ok (null), `pack_ev_publish_shortfall_pct` 0.79 ok; no downstream pack-EV freshness breach. But the probe is now blind ~90% of the time (was ~half on 10-02), so mint detection is largely offline until resolved.
- **Likely cause (NOT a DB spell — DB healthy: snapshot returned fast, trust 38/38 ok, no IO-wait signal):** external mint-availability target degradation, or a Cloudflare-style challenge on that egress (same shape as the Atlas 403 lanes, but a 20 s hang rather than a 403). `upstream=0` = not classified to a known upstream arm.
- **Risk read:** investigation is LOW-RISK / read-only. The fix touches a pipeline/edge dispatch (route logic) — night-pass / Trevor territory; off-limits for the monitor and for an autonomous route change.
- **Suggested action (night pass / Trevor):** identify the mint-availability target the probe dispatches to behind the edge proxy; check for rate-limiting / Cloudflare challenge; either raise the per-probe timeout IF the target is merely slow (not blocked), or add the attributed-403/challenge handling the Atlas lanes already use. Not urgent (no downstream freshness breach) but the probe is near-fully blind.
- **Why it is only now in the inbox:** QUEUED in the ledger + 10-02 handoff since 10-01, but never written to the actionable inbox (the 10-02 pass was off-hours queue-only + no-push). This file makes it drainable.

## Disposition — RESOLVED by #166 (Claude Code, 2026-10-03 ~7:45 AM PT)

This tick (5:06 PM PT 10-02) predates the fix. **#166 (`20261003045659`, shipped ~9:57 PM PT 10-02)** gives a node fault (timeout, HTTP ≥ 500, no response) 12 attempts instead of 4, so a 20 s spell on the mainnet24 historical node no longer fails a probe for good. The `failure_rate` arm counts attempts, so it stays lit **by design** while the backward walk is on mainnet24 (focus.md steer, 10-03). Lengthening the timeout was measured harmful on 10-02 and is not the lever.

Re-checked live just now against the focus.md re-open trigger (`status='failed' AND attempts >= 12` growing): `pack_mint_probes` = done 26,444 · pending 364 · in_flight 25 · **failed 6** (unchanged since 09-29, the by-design "window missed" class) · **attempts ≥ 12: 0**. Not re-opened.
