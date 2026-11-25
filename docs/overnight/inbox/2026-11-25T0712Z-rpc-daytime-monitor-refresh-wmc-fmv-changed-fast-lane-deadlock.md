# Fast-lane wmc writer `refresh_wmc_fmv_changed` hit a deadlock (40P01) + lock timeout — self-cleared, but the 11-10 SKIP-LOCKED fix was never extended to this lane

**Filed:** 2026-11-24 ~11:12 PM PT (rpc-daytime-monitor, read-only daytime sweep)

**Source:** `pipeline_runs` `ok=false` scan, last 6 h. Two consecutive failures on `refresh_wmc_fmv_changed` (the high-frequency wallet-FMV writer, observed cadence ~5 min):
- `2026-11-25 04:13:18Z` — `deadlock detected` (40P01)
- `2026-11-25 04:18:20Z` — `canceling statement due to lock timeout`

These were the ONLY non-upstream pipeline failures in the window (everything else was Atlas/Cloudflare 403, a CF 530, or Solana `getSignaturesForAddress` timeouts — all upstream and transient). `rpc_ops_snapshot()` reported `refresh_wmc_fmv_changed` at 3 fails / 24 h.

**Self-cleared:** the next 10 runs (06:18Z → 07:03Z) are all `ok=true`. Nothing is broken right now; the pair rolled back and the lane caught up on its next ticks.

**Why it is worth handing off anyway (not a one-off class):** the wmc-family deadlock class is already documented and *fixed* — on 2026-11-10 `resync_stuck_wmc_fmv` was rebuilt to take its target rows `FOR UPDATE ... SKIP LOCKED` in a materialized CTE ordered by a unique key, after the Postgres log named `reconcile_saved_wallets_wmc_fmv` as the deadlock partner (same two wmc columns, wallet order vs edition order). See ledger 2026-11-10 (`audit_20261110_stuck_wmc_fmv_resync_skips_rows_another_writer_holds`). That treatment was applied to the resync/reconcile lanes but **not** to `refresh_wmc_fmv_changed`, whose multi-row `wallet_moments_cache` UPDATE takes row locks in join order and can therefore still deadlock with the same partners. Today's pair is that same class surfacing on the one wmc writer that was left untreated.

**Blast radius (read, not guessed):** LOW. Each failed tick rolls back and the next ~5-min tick re-does the same work; `fmv_usd` is eventually-consistent within minutes. Trust health is clean this sweep (43/43 ok, `fmv_stale_touch_hours` 0.3, `topshot_fmv_stale_hours` 0.3, no breaches), so no user-facing staleness resulted.

**NOT a spell:** `rpc_ops_snapshot()` and every drill-down returned promptly; IO is not saturated (no positive-control trip). This is lock-ordering contention between a few wmc writers, not estate saturation — so the cause is interpretable and does not need a quiet-window re-measure.

**Timing note (do not over-read):** the two failures were at :13 and :18, i.e. *between* the heavy pg_cron bands (:03–:09 / :23–:29 / :43–:49), not inside one — so this is lane-vs-lane lock ordering, not the band-saturation story the focus already steers for the `:08` statement-timeout cluster. The partner for these two ticks was NOT confirmed (the Postgres log was not read this read-only pass).

**Suggested action (night pass / Trevor — sensing-only from here):**
1. Read the Postgres log around `2026-11-25 04:13Z` to confirm the deadlock partner (likely `reconcile_saved_wallets_wmc_fmv` :06/:36 or `resync_stuck_wmc_fmv` :33, the same partners named on 11-10).
2. If confirmed, extend the 11-10 treatment to `refresh_wmc_fmv_changed`: take its target `wallet_moments_cache` rows `FOR UPDATE ... SKIP LOCKED` in a materialized CTE ordered by a unique key, then UPDATE by id — byte-identical output, no deadlock. Pinned-function discipline applies (re-derive the live md5 before the write; grants unchanged).
3. If the rate stays ~3/24 h and never causes a trust-health breach, it is acceptable to leave as-is and just close this — the damage per event is one rolled-back tick.

**Context (not re-filed):** the `gha-schedule-watchdog` medium alert in this sweep is the known self-clearing GHA-drop class already filed (`2026-11-23T1913Z-rpc-daytime-monitor-gha-schedule-delivery-stalled.md`); it self-recovered this sweep (last 8 watchdog runs ok=true, ticks resumed 03:08Z), so no duplicate filing.
