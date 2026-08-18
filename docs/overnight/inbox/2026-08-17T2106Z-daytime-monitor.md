# Daytime monitor — 2026-08-17T21:06Z (14:06 PT, afternoon tick)

**Verdict: HEALTHY / known-class. Zero NEW ship-eligible candidate work.** Third delta of the day against the 15:18Z calibration note and the 18:06Z delta. Written to mount (push unavailable — pushurl carries no credential, the standing sandbox NO-PUSH state).

## Headline: the daytime saturation window is EASING through the afternoon, but still open

The one genuinely-new signal no single prior note captures is the trend. pg_cron statement-timeout failures across today's three ticks:

- 08:18Z (~20 failing) → 11:06Z (14) → 14:06Z (**8**).

Monotone decline — saturation is receding as the PT working-hours + cron overlap thins, exactly the shape focus STEER #3 predicts. Still non-trivially open at 2pm PT: `rpc_ops_snapshot()` again timed out (57014) on its live FMV-confidence leg, and one `execute_sql` call returned a connector timeout mid-sweep. One root cause (disk-IO budget, SMALL tier) — no new investigation. Logged as a timing data point only.

The 8 currently-failing pg_cron jobs are all `canceling statement due to statement timeout` (or one `job startup timeout`) on heavy MV refreshes / aggregations: `rpc-refresh-allday-pack-realized` (3/4 in window), `rpc-refresh-topshot-pack-sales-agg`, `rpc-thp-leg-impossible-parallel`, `rpc-thin-sale-ask-disclosure-refresh`, `rpc-refresh-new-collectors`, `rpc-thp-leg-pinnacle-fmv-share`, `rpc-attribute-pack-rips-empirical`, `rpc-refresh-misattrib-candidates`. Newest fails 18:35–18:50Z (11:35–11:50 PT) — the noon-PT saturation peak, not post-fix findings. All saturation-class.

## The one offender not yet named in today's notes (low confidence, likely same class)

- **`compute-golazos-pack-ev` stalled — 871 min silent vs 800 threshold (last run 2026-08-17T06:37Z), severity medium.** Only ~9% over its own threshold = one missed scheduled tick under the active saturation window. Not filed in the 15:18Z / 18:06Z notes. **Almost certainly saturation-collateral** (a pack-EV compute cron losing a tick, same class as `compute-topshot-pack-ev`'s selection-query timeouts already filed `…T1806Z`), not a new break. Night pass: worth a glance to confirm it recovers on its next tick; do NOT treat as a distinct investigation unless it persists past the saturation easing.

## Clean / healthy (this tick)
- **Security 4/4 clean** — `check_public_security_invariants()` 0 rows, `check_secdef_anon_exec_drift()` [], `check_anon_write_surface()` 0 rows, RLS-off base tables 0.
- **Vercel 0 ERROR** — 20 recent: 5 READY / 15 CANCELED (CANCELED = superseded docs-only commits, normal `ignoreCommand`).
- **DB 13,142 MB** (nightly 13,114 → 18:06 13,134 → now 13,142 — stable slow growth). **editions 27,199** (27,193 → 27,193 → 27,199 — flat).
- **Artifact estate intact** — 11 artifacts enumerated via `list_artifacts` (unchanged set: rpc-live-health, rpc-tracked-fmv-confidence, rpc-qa-scorecard, rpc-traction, rpc-my-wallet, rpc-deploys-and-cost, rpc-rewards-console, rpc-pack-lifecycle, rpc-set-challenge-roi, rpc-panini-squeeze-v2, candy-chain-two-onboarding-v2). Payload-query validation deferred again, same reasoning as both prior ticks: running 11 heavy multi-CTE reads against an instance still timing out its own baseline adds load with an ambiguous result. No schema-breaking migration shipped today. Re-validate on a low-saturation tick.

## Known arms confirmed (not findings)
- `candy-editions-ingest` stalled 3628 min (last ok 08-15 08:40Z) — 300s-kill / unbounded-runtime class, filed `inbox/2026-08-17T0030Z`. Medium (user-facing, editions change slowly).
- Trust breaches unchanged known-class set: `panini_sale_price_capture_dry_days` (cry-wolf, re-point queued), `unmapped_resolution_backlog_max` (AllDay permanent floor), `public_board_slow_count` / `board_mv_refresh_stale_hours` (saturation-sweep collateral). Not re-enumerated in full — the trust view itself is expensive under saturation and the set has not moved across today's three ticks.

## Not independently re-polled this tick
- **Sentry** — not re-queried via MCP this tick (the 15:18Z and 18:06Z ticks both found only a single entity-page `get_team_players` 45s-abort event, saturation collateral, no spike; nothing indicated a change). Night pass should re-poll on its own pass.

## For the night pass
Nothing SHIP-eligible. Every finding maps to an already-filed item or a known arm. The carry-forward signal: afternoon saturation is EASING (pg_cron fails 20→14→8 across 08:18/11:06/14:06Z), so a "clean" 01:00 PT nightly board continues to under-represent working-hours load — but the peak has passed by mid-afternoon. Only genuinely-un-filed observation is the marginal `compute-golazos-pack-ev` tick miss above. Standing escalation unchanged: git push dead in sandbox (blocks code deploys + inbox archival).
