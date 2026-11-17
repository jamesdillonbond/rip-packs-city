# Daytime monitor — 2026-08-17T18:06Z (11:06 PT, later tick)

**Verdict: HEALTHY / known-class. Zero NEW candidate work.** This is a short DELTA against the thorough 15:18Z calibration note (`inbox/2026-08-17T1518Z-daytime-monitor.md`) — the board is materially unchanged 3h later. Written to mount (push unavailable — pushurl carries no credential, the standing sandbox NO-PUSH state; nightly's 08:11Z release note carries the same escalation).

## Delta vs 15:18Z: the daytime saturation window is still open, board otherwise flat

- **Saturation persists into the 11am PT window.** `rpc_ops_snapshot()` still times out (57014) on its live FMV-confidence leg. `v_rpc_trust_health` DID answer this tick (filtered to BREACH); `check_public_security_invariants()` + `check_anon_write_surface()` answered cheaply and are CLEAN. One root cause (disk-IO budget on SMALL tier), already filed exhaustively — no new investigation (focus STEER #3). Logged only as a timing data point: saturation is still heavy at 11am PT, consistent with the 15:18Z read.
- **`pipeline_runs` 6h = a wall of timeouts** (16:29–18:09Z): `refresh_wmc_fmv_drift_active` (repeating), `refresh_wmc_fmv_changed` (lock timeout), `wallet-username-resolver` (filed `…T0440Z`), `compute-topshot-pack-ev` (`targets:` selection-query timeout, the selection-is-expensive class), `populate-pinnacle-wmc-fmv`, `pinnacle-nft-resolver`, `refresh-insights-cache`, `alerts-dispatch`, `lock-check-batch`, `refresh-error-triage`, `allday-unmapped-resolver` — all statement/lock/upstream timeout. Plus the two known non-saturation ones: `sync-nba-projections` `all_upstreams_failed` (sports-proxy 403, Known issues #8, operator-only) and `reconcile-saved-wallet-stats` `soft_deadline_reached_partial_sweep_committed` (designed graceful degradation).
- **pg_cron: 14 failing**, all `canceling statement due to statement timeout` or `job startup timeout` (nightly saw ~7, 15:18Z ~20 — this tick sits between them; it flexes with the saturation, not a trend). Includes `rpc-refresh-market-index-daily` (12:07Z, cause of the `board_mv_refresh_stale_hours` breach) and `rpc-public-board-liveness-sweep` (12:28Z on `panini_squeeze_board`, cause of the two 999 board arms) and `rpc-thp-leg-impossible-parallel` (12:48Z, freezes `topshot_impossible_parallel_serials`).

## Trust: 5 breaches, ALL known-class (unchanged set, minus the fmv_sweep_wedge that cleared overnight)
- `board_mv_refresh_stale_hours` **11.92** vs 8 — `mv_topshot_market_index_daily` stale from the 12:07Z market-index cron timeout. Cadence-vs-threshold mismatch documented in CLAUDE.md (6-hourly job vs 8h threshold = one miss guarantees breach). Not new.
- `public_board_empty_count` **999** + `public_board_slow_count` **999** — the board-liveness-sweep `budget_exhausted → inconclusive` branch (NOT the exception sentinel), from the 12:28Z sweep timeout. Documented at length in CLAUDE.md.
- `panini_sale_price_capture_dry_days` **20** vs 3 — known cry-wolf arm (+1/day forever on a deliberately-abandoned field; the RE-POINT is queued, threshold derived, operator/night-pass call — do not chase capture).
- `unmapped_resolution_backlog_max` **291** vs 100 — AllDay permanent-class floor; its own text says do NOT raise `breach_at`.

## Clean / healthy
- **Security 3/3 clean** — RLS-off base tables 0, invariants 0 rows, anon-write 0 rows.
- **Vercel: 0 ERROR** (5 READY / 15 CANCELED; CANCELED = superseded docs-only commits, normal `ignoreCommand`).
- **Sentry: 1 new issue in 6h** — `JAVASCRIPT-NEXTJS-2J` "team roster unavailable: rpc get_team_players timed out after 45000ms" on `GET /[collection]/team/[slug]`, **1 user / 1 event**, 4h ago (same single event the 15:18Z note flagged; no spike). Entity-page 45s-abort family, saturation collateral.
- **DB 13134 MB** (nightly 13114 — stable). editions 27,193. Trust precompute freshness: 19 metrics, max age **11.42h** (elevated from the ~5.7h steady state, reflecting the impossible-parallel leg frozen by the 12:48Z timeout — the 8-way split isolating one leg exactly as designed, under the 13h breach).

## Stalled pipelines (3, all known)
- `candy-editions-ingest` 3448 min silent (last ok 08-15) — 300s-kill/unbounded-runtime class, filed `inbox/2026-08-17T0030Z`. Medium.
- `allday-pack-opens-backfill` 103 min vs 90 — finite walk near floor; pg_cron 55 still firing (saturation-throttled). Marginal, not a new stall.
- `topshot-moments-hydrator` 47 min vs 30, info — marginal saturation collateral.

## Artifact validation
Deferred this tick, same reasoning as 15:18Z: the 11 payload queries are heavy multi-CTE reads, and running them against an instance already timing out its own baseline adds load with an ambiguous result (a timeout is saturation, not a broken artifact). No schema-breaking migration shipped today. Estate structurally intact — 11 artifacts enumerated (rpc-live-health, rpc-tracked-fmv-confidence, rpc-qa-scorecard, rpc-traction, rpc-my-wallet, rpc-deploys-and-cost, rpc-rewards-console, rpc-pack-lifecycle, rpc-set-challenge-roi, rpc-panini-squeeze-v2, candy-chain-two-onboarding-v2). Re-validate on a lower-saturation tick.

## For the night pass
Nothing SHIP-eligible. No new candidate — every finding maps to an already-filed item or a known arm. The only signal worth carrying: the daytime saturation window that the 15:18Z note flagged is STILL open at 11am PT (3h later), so the "clean" 01:00 PT nightly board consistently under-represents working-hours load. All specific offenders already filed (`…T0320Z` monitoring-gap, `…T0410Z` pgcron-startup-timeout, `…T0440Z` wallet-username-resolver, `…T1211Z` saturation-self-throttle). Standing escalation unchanged: git push dead in sandbox (blocks code deploys + inbox archival).
