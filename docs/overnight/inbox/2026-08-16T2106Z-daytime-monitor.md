# Daytime monitor — 2026-08-16T21:06Z (14:06 PT)

READ-ONLY sweep. Lock present but RELEASED (16:20Z). Written to mount — clone/push documented 403-dead today (prior lock).

## Verdict: ✓ HEALTHY — no new candidates. Everything found is already filed today or known-class. Very active concurrent CC/Cowork session (30 inbox files today, dozens of commits).

## Confirmations for the night pass
- **Leg split (jobs 324–331) FULLY CONVERGED / GREEN.** `trust_precompute_max_age_hours` now well under breach: max precompute age 5.37h (< 13), settled at the predicted ~5.7h steady state. `topshot_impossible_parallel_serials` = 0.00. The 1855Z falsifier PASS + 1615Z re-breach prediction are both borne out. Do NOT revert.
- **fmv_sweep RECOVERED unaided** (Trevor commit `8578`, 20:40Z): `fmv_sweep_wedge_hours` 13.40→0.04, cursor 0→2000. The prior pass's "top undiagnosed candidate" is diagnosed (page-0 catch-up poison × saturation) and self-cleared. Not re-flagging.
- **Security 4/4 CLEAN**: rls_off_base 0, invariants ∅, anon_write ∅, secdef_drift []. `v_pack_pipeline_health` (rebuilt today) resolves, 10 rows — no schema break from today's 6 migrations.
- **Saturation moderate/normal**: 13.6% DataFileRead, 7 active/44 total (band 0.9–18.6%).

## Known-class, do NOT re-alarm
- **~21:00Z failure burst (wallet-backfill `Could not query the database for the schema cache` PGRST002 + pool timeouts, thousands of `rows_lost`)** = collateral from TWO concurrent-session migrations 5 min apart (`20260816205639` + `20260816210146`, board_liveness_sweep_*). Documented ~10–20s PGRST002 burst per apply; wallet-backfill re-walks self-heal. NOT a regression.
- **`public_board_empty_count` + `public_board_slow_count` = 999 (sentinel) at ~20:47Z** predate those two board-liveness fix migrations (20:56Z/21:01Z) — STALE pre-fix runs, being actively repaired by the concurrent session. Should clear on next board-liveness tick. Do NOT file as a new incident.
- **candy-editions-ingest stalled ~36h** (silent since 08-15 08:40Z, medium) — filed 1545Z (maxDuration lever exhausted, handoff exists). Unchanged.
- **8 pg_cron fails, all saturation-class** (`statement timeout` / `job startup timeout`: rpc-refresh-mv-pack-ev-latest 6/48, pinnacle-acquisitions, allday-pack-realized, candy-wmc-ghost-purge, serial-fmv-multipliers/jersey weekly, thin-sale-ask-disclosure, pinnacle-fmv-recalc-backstop) — the documented disk-IO saturation class, filed 1921Z (pg-cron loses 2–4% of ticks).
- **2 new Sentry (NEXTJS-2F/2G, ~20:53Z)** = `smoke check could not run` under the migration/saturation window — `couldNotRun` honest-degradation working, single events, self-resolving. Not a break.
- **Persistent trust breaches** (panini_sale_price_capture_dry_days 19, unmapped_resolution_backlog_max, fmv_sweep_stall_pct_24h) all known-class, previously filed.

No inbox candidate written beyond this heartbeat.
