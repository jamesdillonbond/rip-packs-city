# Candidate — `rpc-roll-pack-ask-hourly-low` shows a `deadlock detected` signature (SYMPTOM, observed in a spell)

- **Filed by:** rpc-daytime-monitor · 2026-08-18T18:08Z (~11:08 PT)
- **Class:** SYMPTOM — observed under active saturation. **Suggested action is a quiet-window RE-MEASURE, not a fix.**

## One-line
`rpc-roll-pack-ask-hourly-low` (pg_cron job 9 → `roll_pack_ask_hourly_low`, 15-min pack-ask-low ratchet) is failing with `ERROR: deadlock detected` — 9 fails in the check window, most recent **2026-08-18 18:07:01Z**, i.e. within the current spell.

## Source
- `check_pgcron_recent_failures()` — this run. `last_fail_message`: `deadlock detected … Process 3272655 waits for ShareLock on transaction 11368592; blocked by process 3272586`.
- Positive control at run start: **14 IO-wait vs 13 active** sessions in `pg_stat_activity`, and `rpc_ops_snapshot()` timed out on `sentinel_fmv_confidence_rows` → the DB is IN a saturation spell (Section 1c). Every duration/contention read this hour is uninterpretable.

## Why this is called out separately from the other 26 pg_cron fails
The other ~26 recent pg_cron failures are all `canceling statement due to statement timeout` / `job startup timeout` — one root cause (disk-IO budget on the SMALL instance), per focus **not** to be re-investigated as N distinct bugs. This one is a **different signature — a lock-ordering deadlock**, not a timeout, so it does not fold cleanly into "saturation collateral" and is worth a look. `roll_pack_ask_hourly_low` is a known heavy job already swept onto `cron_heavy` (ledger 2026-07-12) for hitting the 120s wall.

## Risk read — LOW blast radius
- The ratchet is a down-only `LEAST` capture of the intra-window low ask; a deadlock-victim tick rolls back whole and the next 15-min tick re-captures. Worst case is a missed intra-15-min low-ask minimum — minor pack-deal/discount-surface accuracy loss, self-healing.
- Its pin (ledger 2026-08-02) notes an `EXCEPTION WHEN OTHERS` around its `log_pipeline_run`, so a logging failure never fails the roll — but a **deadlock aborts the whole transaction**, so the roll itself is what's rolling back here, not just the log.

## Suggested action (for the night pass / Trevor)
1. **Re-measure in a quiet window first** (positive control: majority of active sessions NOT in IO wait). Deadlocks become far more likely under saturation because transactions hold locks across long IO waits, so this may be pure spell aggravation that clears on its own — do NOT conclude a standalone concurrency bug from a spell-time reading.
2. **If the deadlocks persist off-spell**, this is the same write-contention class fixed for `apply_lock_check_batch` on 2026-07-17: claim rows `FOR UPDATE SKIP LOCKED` in a stable key order and update only claimed rows (deadlock-impossible by construction). That is route/function-logic on a pricing write path → Claude Code, not auto-shippable. WATCH: graduates to a fix only if it climbs across days.

## Not-a-finding notes (recorded so they aren't re-raised)
- 9 stalled pipelines (`detect_stalled_pipelines()`): `compute-golazos-pack-ev` ~35.5h silent is the known TS-only-arm-blind golazos pack-EV staleness (ledger 08-18); the rest are documented monitoring defects (`candy-listings-indexer` terminal-row oscillation) or heavy MV refreshes killed under the spell. No new breakage.
- Security clean: `check_public_security_invariants()` [], `check_anon_write_surface()` [], `check_secdef_anon_execute_violations()` len 0, RLS-off public tables 0.
- Vercel: latest READY prod deploy `562688df`; the one ERROR (`714f5d65`) is superseded and already fixed by later commits. Sentry: 0 new / 0 escalating in 24h.
- Artifact payload validation SKIPPED this run per Section 1c (do not stack heavy payload queries onto an active spell) — re-validate in a quiet window.
