# Daytime monitor candidate — 2026-10-02T1510Z (first tick of day, ~08:05 PT)

## pg_cron `rpc-wallet-reconstructed-rips` crossed its 120 s statement_timeout and FAILED today's only run

- **Title:** Daily `rpc-wallet-reconstructed-rips` (`37 10 * * *`) now times out — its runtime grew 11.6 s → 120 s over six days and today's tick was killed at the 120 s cap.
- **Source:** `check_pgcron_recent_failures()` → job `rpc-wallet-reconstructed-rips`, last_run 2026-10-02 10:37:00Z, message `canceling statement due to statement timeout` in the `pulls AS (SELECT DISTINCT ON (ma.coll…)` CTE. Same-slot run history: 09-27 11.6 s · 09-28 20.8 s · 09-29 13.6 s · 09-30 56.8 s · 10-01 80.9 s · 10-02 FAILED (120.0 s, killed).
- **Not a spell artifact:** positive control not tripped this run — `rpc_ops_snapshot()` and every probe returned promptly, no IO-wait saturation. The growth is a six-day, one-sample-per-day trend at a fixed slot, not an intra-spell tail, so the runtime growth is a real measurement. A single daily job hitting its own cap is NOT the "cluster of statement timeouts = saturation collateral" class.
- **Likely cause (for the night pass to confirm, not asserted here):** plausibly downstream of the late-Sept chain-arrival seeding (ledger 09-29 / 09-30: 14,446 + 996 + more SOLD moments seeded into `chain_arrival_probes` → `moment_acquisitions` pack-pull rows), which is what `rebuild_saved_wallet_reconstructed_rips()` reconstructs per saved wallet. More delivered rows per wallet ⇒ a bigger daily rebuild. Re-measure before crediting.
- **Blast radius:** LOW / narrow — `wallet_reconstructed_rips` for the saved wallets is one day stale; it is a pack-history enrichment, not a public board or FMV. It is a DAILY job, so it will not retry until the next 10:37Z tick and will fail again unless addressed.
- **Risk read:** low-risk to investigate; fix is bounded.
- **Suggested action (night pass / Trevor):** either raise the per-job `statement_timeout` for this one once-daily batch (a larger budget is cheap for a daily job), or chunk / optimize the `DISTINCT ON (ma.coll…)` pulls CTE (walk saved wallets in batches rather than one statement, or add the delivery-grouping index). Measure the rebuild cost in a quiet window before picking. Do NOT widen a shared `statement_timeout`.

---

## ✅ Disposition (Claude Code, 2026-10-02 ~8:40 AM PT): already fixed upstream when filed.

- Migration `20261002144052` (ledger, ~7:50 AM PT) shipped about 15 min before this tick. The function's header `SET statement_timeout '600s'` does nothing under pg_cron, so the 600 s budget moved into the pg_cron command. The rebuild now runs smallest wallets first, each in its own sub-transaction, and a kill is recorded instead of rolled back.
- Catch-up run at 8:03 AM PT (`pipeline_runs`, read 8:40 AM): **ok, 33/33 wallets, 0 failed, 22,118 rows, 118.7 s**. That is 20 % of the new 600 s budget.
- The growth this filing measured (11.6 s → 120 s) followed the input: pack-pull rows for the saved wallets quadrupled with the one-off 09-29/09-30 chain-arrival seeding (+37,906 rows in 72 h). Cost per wallet is linear. That was a one-time step, not a daily growth rate.
- **Exit:** the 10-03 3:37 AM PT row exists, either ok or ok=false naming `stopped_at`.
