# IO saturation since ~6:30 PM PT persists after the R101 revert AND after the 940 MB `wallet_moments_cache` autovacuum finished — the Atlas listing lane is timing out on 9 of 12 ticks and no single hog shows in `pipeline_runs`

**Filed 2026-09-19 02:45Z (2026-09-18 7:45 PM PT) · Claude Code cloud · the R101 session, after its own revert**

## What was measured (same instrument throughout: `cron.job_run_details`, succeeded+failed only; p50 seconds / failed of runs)

| lane | 5:30–6:28 PM | 6:30–6:50 PM | 6:50–7:14 PM | **7:16–7:40 PM (R101 reverted 7:14 PM)** |
|---|---|---|---|---|
| `rpc-ts-listings-atlas-sync` | 12.9 / 0 of 29 | 36.0 / 1 of 10 | 120.0 / 10 of 12 | **120.1 / 9 of 12** |
| `rpc-allday-unmapped-atlas-resolver` (untouched) | 14.4 / 0 of 11 | 76.9 / 1 of 4 | 120.1 / 3 of 4 | **114.5 / 2 of 4** |
| `rpc-atlas-market-drain` (untouched) | 7.5 / 0 of 29 | 5.4 / 0 of 10 | 42.4 / 0 of 12 | **47.8 / 0 of 12** |

- **R101 (`20260919012821` + `20260919014753`) is RULED OUT as the cause:** it was reverted at 7:14 PM PT (`20260919021449`, bodies md5-matched to the pre-change source) and the fourth column did not move.
- **The `wallet_moments_cache` autovacuum (120,286 heap blocks ≈ 940 MB, ran ~6:55 → 7:20 PM PT) is ruled out as the SOLE cause:** it finished at 7:20 PM (`last_autovacuum 02:20:37Z`) and the fourth column still holds. `pg_stat_progress_vacuum` was empty at 7:40 PM.
- **Busy seconds per minute since 7:16 PM, top of the fleet:** `rpc-ts-listings-atlas-sync` 53.6 (at the 120 s cap, a victim that amplifies) · `rpc-allday-unmapped-atlas-resolver` 21.5 · `rpc-atlas-market-drain` 20.2 · `rpc-refresh-wmc-fmv-changed` 20.1 (**one run 361 s**; its steps `refresh_wmc_fmv_drift_active` 24–25 s, `wmc-fmv-populate` per-collection 16–23 s — every WMC step 20–100× its normal) · `rpc-pack-nft-identity-lane` 10.8 (NEW tonight, 1 of 5 timed out) · three MV refreshes at the top of the hour 121–194 s each. Every active client backend read `wait_event_type = IO` at 6:40 and 7:18 PM.
- Against the hour-of-day baseline in the 01:30Z filing (this lane 7–55% timeouts by hour; the 00Z hour reads 19.6%), **75% is above every hour's baseline** — this is a spell on top of the chronic state, not the chronic state.

## What is NOT known

- **The driver.** `pipeline_runs` shows every lane slow, none anomalous in ROWS — consistent with an IO ceiling reached, not one runaway query. Candidates not separable from here: the new pack lanes (`rpc-pack-nft-identity-lane` every 5 min since ~6:23 PM, its 793-line migration also touches `wallet_packs`), the 0.02 autovacuum factor on `topshot_atlas_market_events` (6:13 PM; vacuums now every ~47k dead tuples on a table that flips `completed` all day — each is a walk of a 1.2 GB relation), the WMC churn from `refresh_wmc_fmv_changed(30, 200000)` feeding the next WMC vacuum, or Vercel-side traffic this box cannot see.
- **Whether it has ended.** The last reading is 7:40 PM PT.

## Suggested action (monitor / night pass)

1. **Re-read the table above at the next tick; if the fourth column has recovered, this was a spell and the night pass can proceed.** If not, read `pg_stat_progress_vacuum`, autovacuum workers, and `pg_stat_activity` IO waits FIRST — the tame table's new 0.02 factor may be vacuuming a 1.2 GB relation on a cadence the instance cannot afford; the falsifier for `388dc4783` should include **autovacuum_count on that table per hour**, not only heap fetches.
2. Do NOT re-apply R101's open-book design under saturation; its re-apply path and two design lessons are in the 7:14 PM ledger entry (slim `_open24`, no per-tick memory grants, measure against the control lanes on a quiet estate).
3. The sentinel's Measurement Blackout / saturation arms should be reading INCONCLUSIVE tonight; a HEALTHY verdict from the 1 AM pass under this state would be the "sweep ok ≠ lanes ok" shape.

## Update 8:07 PM PT (03:07Z) — EASING, not over

Same instrument, 7:46 → 8:07 PM PT: `rpc-ts-listings-atlas-sync` **64.7 s p50 / 2 of 10 failed** (was 120 / 11 of 15) · `rpc-atlas-market-drain` **18.7 s** (was 48.6) · `rpc-allday-unmapped-atlas-resolver` 84.0 s / 1 of 4 (was 114.5 / 3 of 6) · `rpc-refresh-wmc-fmv-changed` 168 s (was 361). Baseline for the first two is 12.9 s and 7.5 s, so the estate is ~half-way back. Two candidates weakened by measurement: `topshot_atlas_market_events` has NOT vacuumed again since 6:15 PM PT (`autovacuum_count` 150 at both 7:18 and 8:05 PM; 33k dead tuples against a ~47k trigger), so the 0.02 factor did not fire repeatedly tonight; and a 43 s `pg_stat_io` delta at 8:05 PM read ~3 MB/s of client-backend relation reads with zero vacuum reads — quiet at that instant. What remains unexplained is the 6:30–7:45 PM plateau itself; the WMC vacuum (6:55–7:20) and the new pack lanes remain the candidates with a mechanism.
