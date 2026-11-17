# Daytime monitor — 2026-09-12 ~20:06 PT (2026-09-13T03:06Z)

READ-ONLY sweep. Push path down (Cowork VM shell dead since the 09-08 Windows update; per today's ledger). **Inbox written to mount, push unavailable** — night pass picks it up locally. Evening tick, so the 1a first-tick-of-day extras (trust-health full row walk, cross-collection verify) are intentionally skipped.

## Health at a glance
- ✓ Security invariants 4/4 clean (invariants / anon_write_holes / rls_off_base / secdef_anon all `[]`).
- ✓ Vercel: no deploy in ERROR across the last 20; production READY present; newest is BUILDING (Claude `docs(register): file #92/#93` commit — docs tip, expected in-progress, not an alarm).
- ✓ Not in a spell now — `pg_stat_activity` at 03:06Z reads **io_wait=0 / active=0 / 30 total**. The day was spell-prone earlier (05:00–12:00 PT and an 18:00–23:25Z pg_cron timeout cluster per the ledger); it is quiet now.
- 1 trust-health BREACH (`topshot_impossible_parallel_serials` = 27) — tracked #82, see below.
- DB 29,108 MB. `sentinel_ts_uuid_editions_48h` = 0. `ts_uuid_dupes_created_24h` = 0 (ok).

## No new actionable candidates this tick
Everything observed maps to an already-tracked item or a known by-design arm. Nothing clearly-safe and new to hand the night pass.

## Re-measure that CLOSES the 00:09Z tick's Candidate 2 (precompute/boards self-healed as predicted)
The 2026-09-13T00:09Z filing flagged `trust_precompute_max_age_hours` = 17.3 (breach_at 13) and `public_board_slow_count` = 10 (breach_at 1) as **spell collateral**, with the exit test: re-measure in the 02:00–06:00Z quiet window; if back under threshold it was collateral (close). **It is: now `trust_precompute_max_age_hours` = 5.3 (ok) and `public_board_slow_count` = 0 (ok).** Self-healed on the uncontended refresh tick exactly as predicted — close it, do not chase.

## Watch datapoint (tracked #82, no new action) — impossible-parallel count climbed 5 → 27
`topshot_impossible_parallel_serials` reads **27** (breach_at 3), up from **5** at the 00:09Z tick. The value is a genuine precomputed count (not the 999 stale-sentinel: `trust_precompute_max_age_hours` = 5.3, well under the 24h that would trip 999). The climb is consistent with the filed finding that its self-heal is a **structural no-op** (inbox `2026-09-11T0927Z`, migration `20260911103459`) — mis-keyed-sales accumulate and the healer does not retire them, so the arm drifts upward until the real fix (the sale-keying logic at the 4 writers) lands, which is push-gated code, not a night-pass DB ship. Recorded as a trend, not re-filed. ⚠ Worth a human eye if it keeps climbing steeply tick-over-tick, since the arm is an F1 data-accuracy detector.

## Known / not re-logged (verified against ledger + register this pass)
- **Cron-silent cluster** — `snapshot-pack-asks`, `golazos-listings-indexer`, `allday-listings-indexer`, `allday-listings-retry`, `pinnacle-events-ingest`, `pinnacle-listings-retry` all last ran **01:16:35Z** (~110 min silent). NOT a sudden stop: each fired only **3× in the last 6h, in identical batch-second clusters** (21:39:01Z, then 01:16:35Z) — the known intermittent cron-job.org / dead-lane backstop cadence (#80/#76), already flagged as an operator/cron-job.org item in the 00:09Z tick. External to fix (Trevor re-enabling the cron-job.org entries). Not re-filed.
- **pg_cron failures (`check_pgcron_recent_failures`)** — 4 jobs, ALL `canceling statement due to statement timeout`, no logic errors: `rpc-ccm-step2` (23:25Z), `rpc-pinnacle-fmv-recalc-backstop` (22:37Z), `rpc-topshot-onchain-rekey` (11:33Z), `rpc-fmv-clamp-disconnected-ask` (08:55Z). Each `1/1` in-window, spread across the day — saturation collateral from the earlier spells (#73/#84/#85), each retries on its next tick. The FMV chain owns ~60% of disk IO; the 09-09 trigger lead is the open root, already tracked.
- **Pipeline failure-rate alerts** — `offers-sweep` 7/7 (GraphQL 530, intentionally disabled on cron-job.org, tailing off); `sales-counterparty-backfill` 248/574 (pooled across today's 12:31 PT cursor-reset fix — ledger 2026-09-12; post-fix ticks do real work, 120 rows_found/written); `allday-buyer-backfill` / `fmv-backfill` / `lock-check-batch` / `price-snapshots` / `run-insider-detectors` — statement-timeout saturation collateral, documented.
- **`pack_distributions` data_stale 9d** — known.
- **Atlas 403 arms** (editions 7.5%, market 3.2%) + **`flow-rest-moment-moved-400`** 37.2% — self-attributed `info` arms, by design, freshness green (`atlas-market` last ok 03:05Z, newest event 02:55Z).
- **`unmapped-sales-nfl_all_day`** 30,845 actionable (info, ~19.3d to clear at net rate) — known resolver backlog.

## Artifact validation
Artifact estate intact — 11 active artifacts enumerated (retired tombstones absent, as expected). Core health-vector source (`rpc-live-health` → `rpc_ops_snapshot()`) validated this pass: succeeded, all keys sane. Per-artifact payload queries NOT individually re-run — the day has been spell-prone and each payload query is heavy IO on this tier; the core source validated fine and re-running the full estate risks re-introducing load. Defer full per-artifact validation to a confirmed-quiet tick (consistent with the 00:09Z tick's judgment).
