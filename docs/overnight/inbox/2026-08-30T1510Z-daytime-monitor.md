# Daytime monitor candidates — 2026-08-30T15:10Z (08:10 PT, first-tick run)

Context: NOT in a saturation spell at sweep time (pg_stat_activity IO-wait 2, active 1, rpc_ops_snapshot() returned fast). But the pg_cron failure list carries a cluster of ~14 `statement timeout` / `job startup timeout` failures timestamped across today's 08:xx and 13:57–14:13Z storm bands — saturation collateral (Section 1c), ONE spell, not N bugs. That whole story is already the subject of ~14 ledger ship entries today and is queued for operator; not re-filing it.

## Candidate 1 (LOW) — `refresh-pack-grail-metrics-mv` cadence-watchlist arm may be tight for its new hourly pg_cron form
- Source: `detect_stalled_pipelines()` → refresh-pack-grail-metrics-mv, silent 105 min vs `max_silent_minutes`=90; pg_cron `rpc-refresh-pack-grail-metrics-mv` (jobid 384) `job startup timeout` on the 14:23Z tick (fails_in_window 1/15).
- Read: The refresh moved from the killed maxDuration-60 route to pg_cron jobid 384 (`23 * * * *`, hourly) on 2026-08-29 (migration 20260829235752). An hourly job that loses ~3–4% of ticks to the fleet-wide `job startup timeout` mode will periodically sit >90 min since its last *terminal* row, tripping the 90-min arm on a single lost tick even though the matview is fresh (the run function catches a cancel into ok=false; kills commit server-side per the grail-MV commit-control note). So the arm is expected to false-breach intermittently now.
- Risk: none — this is a watchlist-threshold observation, not a data change.
- Suggested action (night pass, quiet-window verify first): consider widening `pipeline_cadence_watchlist.max_silent_minutes` for refresh-pack-grail-metrics-mv to ~130 min (≈2 lost hourly ticks) so a single saturation-lost tick is absorbed, OR confirm the current 90 is intentional and accept the periodic info-level breach. NOT saturation-dependent to verify; measure last-terminal-row cadence over a clean 72h window before changing.

## Not filed (already tracked / expected — listed so the night pass sees they were considered)
- Trust breaches `unmapped_resolution_backlog_max`=294 (chronic AllDay residual, ~716–750d to clear, do-not-raise-breach_at) and `public_board_slow_count`=11 (saturation-band collateral; self-clears as IO eases) — both known.
- Top Shot legacy-endpoint outage (~38h+, public-api.nbatopshot.com 530/1033) and its downstream topshot-* pipeline failures (topshot-badge-catalog 5/5, topshot-deal-floor-serials, topshot-pack-pool-backfill 132) — known; Studio-client migration queued for operator.
- `wallet-username-resolver` 52.6% statement-timeout — known, keyset fix queued.
- Sentry dark since 08-18 — standing operator/billing blocker; not re-probed.
