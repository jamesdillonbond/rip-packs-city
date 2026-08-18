# Daytime monitor — 2026-08-17T15:18Z (08:18 PT, first tick of day)

**Verdict: HEALTHY / known-class. Zero NEW candidate work — every finding maps to an already-filed item or a known arm. This is a calibration note, not a new investigation.**

Written to mount (push unavailable — pushurl carries no credential, the standing sandbox NO-PUSH state; nightly's 08:11Z release note carries the same escalation).

## Headline: daytime disk-IO saturation is ELEVATED vs the 01:00 PT nightly, heavy enough that the health instruments themselves cannot run

At 15:00–15:10Z the SMALL 2 GB instance is saturated enough that the core read-only health checks **time out (57014)**:
- `rpc_ops_snapshot()` — timed out (baseline unavailable this tick)
- `v_rpc_trust_health` (even filtered to `status='BREACH'`) — timed out; fell back to precompute + freshness reads
- `check_public_security_invariants()` + `check_anon_write_surface()` in one combined statement — timed out; re-ran security cheaply (see below) and it is CLEAN

This is **one root cause** (disk-IO budget on the SMALL tier), already filed exhaustively — do NOT open a new investigation (focus.md STEER #3). It is logged here only as a *timing* data point for the night pass: the night pass runs at low-traffic 01:00 PT and will under-observe how bad daytime (traffic + cron overlap) gets. At this tick it is bad enough to blind the baseline instruments.

Related, and all the same cause:
- **`public_board_slow_count` = 999** in `rpc_trust_health_precompute` — this is the **failure SENTINEL, not a real count**. `rpc-public-board-liveness-sweep` was statement-timeout-killed at 12:28Z (`SELECT count(*), count(t.*) FROM panini_squeeze_board`) and `rpc-capture-board-liveness-history` job-startup-timed-out at 12:51Z. So the board-liveness leg couldn't measure and wrote 999. The trust view would show it BREACH — instrument couldn't run, not a real 999 slow boards. (Nightly had it at a real 5 at 08:11Z.)
- **~20 distinct pg_cron jobs failing** on `job startup timeout` / `canceling statement due to statement timeout` (nightly saw ~7). All saturation. Notable: `rpc-backfill-wmc-fmv-confidence` 25 fails (the known #1 disk reader), `rpc-pinnacle-mints-backfill` 32, `rpc-allday-pack-sales-backfill` 20. `rpc-thp-leg-impossible-parallel` (leg 324) failed once at 12:48Z — isolated by the 8-way split (freshness view max age 8.42h on that one metric, under the 13h breach; the other 18 metrics fresh at avg 2.58h).
- **pipeline_runs 6h fails** dominated by `Timed out acquiring connection from connection pool`: `wallet-backfill-allday` 129 (rows_lost≈1400), `wallet-backfill-pinnacle` 104 (rows_lost≈256), `wallet-backfill` 32 (600), `wallet-backfill-ufc` 13 (218). Those `rows_lost` re-walk on the next tick (not permanent). `fmv-recalc` 8 (saturation-class), `refresh_wmc_fmv_drift_active` 40, `compute-topshot-pack-ev` 31 — all connection-pool/statement-timeout.

## Clean / healthy
- **Security: 4/4 clean** — RLS-off base tables 0; `check_secdef_anon_exec_drift()` []; invariants + anon-write returned zero rows (re-run cheaply after the combined view timed out).
- **Cross-collection refresh (1a): healthy** — cohort mat fresh 04:10Z / 179 rows; overlap mat fresh 04:25Z (step1 + step2 both succeeded today); `rpc-ccm-step1` + `rpc-ccm-step2` both active.
- **Trust freshness / leg-split (1a): healthy** — 19 metrics, max age 8.42h (leg 324 `topshot_impossible_parallel_serials`, under 13h breach), avg 2.58h. The 8-way split is isolating the single failed leg exactly as designed.
- **Vercel: 0 ERROR** (9 READY / 11 CANCELED, all CANCELED are superseded docs-only commits — normal `ignoreCommand` behaviour). Newest READY `dpl_H2tagiaDkhi7iJiyFLq1wHbrZJ4a` = the cron self-throttle fail-OPEN fix (`5eda629f`).
- **Sentry: 1 new issue in 8h** — `JAVASCRIPT-NEXTJS-2J` "team roster unavailable: rpc get_team_players timed out after 45000ms" on `GET /[collection]/team/[slug]`, **1 user / 1 event**, 1h ago. Same entity-page 45s-abort family CLAUDE.md documents (NEXTJS-1Z et al.) — a single unlucky visitor during the saturation spell. Not a spike; same root cause.

## Known arms confirmed (not findings)
- `candy-editions-ingest` stalled 3268 min (last logged 08-15 08:40Z) — the 300s-kill/unbounded-runtime class, filed `inbox/2026-08-17T0030Z-candy-editions-runtime-is-unbounded-…`. Medium (user-facing, editions change slowly).
- `candy-listings-indexer` 514 min silent — the detector cry-wolf; heartbeat + `candy_listings.last_seen_at` (06:35Z) confirm it runs+writes but logs a terminal row ~1/3 of ticks. Detector fix filed.
- `allday-pack-opens-backfill` 153 min silent + job-startup-timeout fails — finite walk near floor; pg_cron 55 still firing (saturation-throttled), silence = scheduler-vs-saturation, not a new stall.
- `topshot-moments-hydrator` 57 min silent (vs 30) — marginally over on a 30-min cadence; saturation collateral, not broken.
- Trust breaches: `panini_sale_price_capture_dry_days` = 20 (known cry-wolf, re-point not chase), `unmapped_resolution_backlog_max` (AllDay permanent floor), `public_board_slow_count` = 999 sentinel (above).

## Artifact validation
Deferred this tick **by choice**: the 11 payload queries are heavy multi-CTE reads (rpc-live-health alone is a 14-day FMV-window walk over `fmv_snapshots`), and running them against an instance already timing out its own baseline would add load with an ambiguous result (a timeout is saturation, not a broken artifact). No schema-breaking migration shipped today (docs + the cron app fix only; nightly shipped 0 DB changes), and the nightly validated the estate 7h ago, so the artifacts are structurally intact. Re-validate on a lower-saturation tick. Estate: 11 artifacts (drifted from the SKILL's named list; ids: rpc-live-health, rpc-tracked-fmv-confidence, rpc-qa-scorecard, rpc-traction, rpc-my-wallet, rpc-deploys-and-cost, rpc-rewards-console, rpc-pack-lifecycle, rpc-set-challenge-roi, rpc-panini-squeeze-v2, candy-chain-two-onboarding-v2).

## For the night pass
Nothing SHIP-eligible surfaced. The saturation monitoring-gap and the individual saturation symptoms are already filed (`inbox/2026-08-17T0320Z-pipeline-restoration-sweep-…-and-the-monitoring-gap.md`, `…T0410Z-the-pgcron-startup-timeout-is-not-a-worker-slot-cap-it-is-the-saturation.md`). The daytime data point is only that saturation peaks hard enough during PT working hours to blind the baseline instruments — worth knowing when the night pass reads a "clean" 01:00 PT board.
