# Daytime monitor — 2026-09-14T00:06Z (5:06 PM PT, 2026-09-13)

Read-only sweep. **Quiet window now** — positive control `pg_stat_activity` shows `io_wait 2 / active 2 / total 20` at 00:06Z and `io_wait 0` at 00:09Z, so the afternoon spell the 21:10Z tick was inside has **cleared**. Because we are out of the spell, the finding below is asserted as a real state, **not** a Section-1c symptom. `inbox written to mount, push unavailable` — the sandbox shell/clone is down (Sept-8 Windows-update mount break, ongoing; git untouched, wrote to the mounted tree).

## Candidate 1 (HIGH) — the Top Shot serial-grain sniper feed is DISABLED and its data is 4h24m stale

- **Source:** `cron.job` + `cron.job_run_details` for `rpc-ts-listings-atlas-sync`; `ts_listings` freshness; cross-checked against the 21:10Z monitor filing and the ledger.
- **Observed (quiet-window, so a state not a symptom):**
  - `cron.job.rpc-ts-listings-atlas-sync.active = **false**` (schedule `*/2 * * * *`). The 2-min job that rebuilds `ts_listings` / `cached_listings` / `edition_offers.low_ask` from the Atlas firehose (added 2026-09-07, `audit_20260907 ts_listings from atlas`) is **switched off**.
  - `ts_listings` newest `ingested_at` = **2026-09-13 19:45Z (12:45 PM PT)** → **4h24m stale** at read time; 89,558 rows frozen.
  - `cron.job_run_details`: the job failed every tick 19:36–19:44Z on `canceling statement due to statement timeout` (temp-table builds `_tsl_want` / `_cl_want` and the floor CTE), succeeded once at **19:46Z ("1 row")**, and has not run since — consistent with being set `active=false` immediately after that last success, in the thick of the afternoon spell.
- **What the 21:10Z tick got wrong (worth recording):** it filed `ts-listings-atlas-sync` under "Not truly stalled … still firing on cadence through 19:46Z … silence in pipeline_runs is the censoring artifact." At 21:10Z the last tick was **already 84 min old** for a 2-min job, and the job is now `active=false`. The censoring-artifact reasoning was right for the *reconcile* job but masked a genuinely stopped scheduler here. A `pipeline_runs`-silence explanation does not substitute for reading `cron.job.active`.
- **Blast radius:** the Top Shot **Pack Sniper serial-grain listings** and **`edition_offers.low_ask`** are served from these tables; with the rebuild off they drift stale (cancellations no longer flip, new/removed listings not reflected). User-facing accuracy on the flagship collection's sniper, exactly the surface the 09-07 rebuild restored.
- **Risk read:** LOW to act on (single `cron.alter_job … active := true`, or `cron.schedule` under `SET LOCAL ROLE` per the 08-16 note — night-pass/Trevor territory, not mine). The real risk is that it stays silently off: nothing in the ledger records a decision to disable it, and no watchlist arm fired because a disabled job produces neither a failed run nor a `pipeline_runs` row.
- **Suggested action (night pass / Trevor):**
  1. Determine whether the disable was a deliberate spell-time load-shed (plausible — it was timing out every tick and is the fleet's #1 cron-waste job) or an accident. It is **not** in the ledger either way.
  2. The spell has cleared (io_wait 0), so **re-enable it** to un-stale the sniper — **or** record in the ledger why it stays off.
  3. ⚠ Re-enabling as-is only defers the problem: ledger (~line 1193) measures this job at **6.7 h / 36% of all fleet cron waste — successful runs 25 s, its ~200 failures average 121 s at a 2-min cadence**. During the next spell it will resume timing-out-every-tick and re-contribute to saturation. The durable fix is the query-cost / back-pressure work already flagged for the cron band, not just flipping `active` back on.

## Context — not re-filed (already logged or known)

- **Afternoon IO-saturation spell has cleared.** Filed as Candidate 1 of the 21:10Z tick (a second saturation window with no maintenance op behind it, quiet-window re-measure owed). This tick confirms it is over (io_wait 0 at 00:09Z) — the owed quiet-window re-measures (cron-band-alone saturation; board slowness per-board) can now proceed.
- **pg_cron 6h failures** — `rpc-refresh-{allday,topshot}-pack-sales-agg`, `rpc-allday-ev-corrected-refresh`, `rpc-thp-leg-impossible-parallel`, `rpc-serial-fmv-{jersey,power-model}-weekly`, `rpc-topshot-onchain-rekey` — **all `canceling statement due to statement timeout`, no logic errors → saturation collateral from the just-cleared spell** (CLAUDE.md §1a), not N distinct bugs. Latest fails 11:33–18:50Z predate the recovery; expect them to clear on their next (6-hourly / weekly) tick.
- **Trust-health breaches (3), all consistent with the spell; none re-filed:**
  - `topshot_impossible_parallel_serials = 29` (breach_at 3) — **KNOWN #82**, up from 5, repair Trevor-gated; carried in the released nightly ledger + the 21:10Z tick. Its recompute leg (`rpc-thp-leg-impossible-parallel`) also timed out in the spell, so the 29 is read from a precompute row and should be re-confirmed once that leg completes clean.
  - `trust_precompute_max_age_hours = 17.33` (breach_at 13) — the single-transaction `rpc-trust-health-precompute-refresh` (58 */6, no per-leg handler) missed ~2 cycles inside the spell; the arm is working as designed (watches the watcher). Self-heals on one clean 6-hourly tick; folds into the spell.
  - `public_board_slow_count = 9` (breach_at 1) — boards slow under IO pressure; `public_board_empty_count = 0` so no honesty/empty-state violation. Spell collateral; re-measure per-board in the quiet window.
- **Everything else green:** security 4/4 clean (`invariants`/`anon_write_holes`/`rls_off_base_tables`/`secdef_anon_violations` all `[]`); `sentinel_ts_uuid_editions_48h = 0`; `ts_uuid_dupes_created_24h = 0`; Vercel no ERROR deploys in the last 20 (CANCELED entries are superseded rapid pushes, tip READY is the lock-state fix `05131e9c`). Editions: nba_top_shot 14,015 · nfl_all_day 6,190 · laliga_golazos 575 · ufc_strike 518 · candy_mlb 125. DB 30,546 MB.

## Not done (discipline)

- **Artifact payload validation limited (Section 1b):** the merged dashboard's backbone (`rpc_ops_snapshot`) returned clean, so `rpc-live-health` is functional at the query level. Did **not** re-run all heavy per-artifact payloads — the instance came out of a spell minutes ago and stacking 13 heavy reads onto a just-recovered Small-tier instance is the wrong trade. Full estate re-validation owed in a sustained quiet window.
- No first-tick-of-day (1a) extras — this is a 5 PM PT tick, not the ~8 AM run.
