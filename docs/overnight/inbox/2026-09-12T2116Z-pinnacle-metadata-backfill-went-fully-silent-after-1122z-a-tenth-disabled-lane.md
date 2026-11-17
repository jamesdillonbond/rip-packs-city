# pinnacle-metadata-backfill went FULLY silent after 11:22Z — a tenth dropped lane, not covered by the nine-lanes filing or the GHA backstop

**2026-09-12T21:16Z (2026-09-12 14:16 PT) · rpc-daytime-monitor · read-only sweep · instance IN a saturation spell at measurement (16 of 17 active sessions in IO wait).**
**Written to the mount — bash/git clone unavailable this run (Sept 8 Windows-update outage still active), so no push; the night pass picks this up locally.**

## The one new candidate

**`pinnacle-metadata-backfill` stopped firing entirely after `2026-09-12T11:22:11Z` (04:22 PT) — 9+ consecutive missed hourly ticks (~9.8 h silent).**

- Source: `detect_stalled_pipelines()` (medium, `silent_minutes` 587 vs `max_silent_minutes` 200) + a per-hour `pipeline_runs` histogram.
- Histogram (last 26 h): **exactly 1 run/hour, 0 fails, every hour from 09-11 19:00Z through 09-12 11:00Z**, then **nothing** at 12:00Z…21:00Z. It was at full clean hourly cadence right up to the stop — it is NOT on the 8-ticks/day GHA-backstop floor, and it is **not one of the nine lanes** in `inbox/2026-09-12T0540Z-nine-lanes-…md`.
- The stop is a clean **absence of invocation**, not a failure: the missed ticks are absent from `pipeline_runs`, not present as `ok=false`. So this is not spell collateral (a spell would show timeouts/`ok=false`, of which there are none for this lane).
- Timing: last run 04:22 PT; the next tick (05:22 PT) would have landed at the front of this morning's heavy spell (05:00–06:00 PT ran 238/191 and 159/114 failed/startup-timeout cron per the ledger). **Most likely mechanism: its cron-job.org entry banked consecutive failures during the spell and auto-disabled — the exact same mechanism #76's tail (the 0540Z filing) documents for the nine.** This would make it a **tenth disabled entry.**

**Risk read: LOW–MEDIUM.** Pinnacle metadata freshness (the lane's mint_count / edition_key / disagreement queues) goes stale; no user-facing alarm fires (a lane hourly-then-dark for <30 h is invisible to the 1,800-min silence arm — the same structural blind spot the 0540Z filing calls out). No security/data-integrity exposure.

**Suggested action (sense-only; do NOT ship from here):** when Trevor runs the cron-job.org console session for the nine entries in `2026-09-12T0540Z`, **add `pinnacle-metadata-backfill` (hourly :22) to the re-enable list and confirm its entry is not disabled.** If its cron-job.org entry is in fact still enabled and firing, then the drop is upstream of cron-job.org and is a different finding — re-derive before acting. **Re-check condition:** `pipeline_runs` for `pinnacle-metadata-backfill` returns to ~1 run/hour with `ok=true`.

## Context, not a candidate — the instance is in an active saturation spell (SYMPTOM, re-measure in a quiet window)

Filed as a symptom per Section 1c, NOT as N distinct bugs and NOT with any causal/cost claim:

- `rpc_ops_snapshot()` **timed out** on its `board_mv_refresh_max_stale_hours` leg (the documented trust-board view that can exceed 60 s under load).
- `check_pgcron_recent_failures()` returned a cluster of jobs failing with **`canceling statement due to statement timeout` / `job startup timeout` and no logic errors** — the saturation-collateral signature. Actively failing near measurement: `rpc-ts-listings-atlas-sync` (286 fails / 719 runs, last 21:08Z), `rpc-allday-unmapped-atlas-resolver` (74/287, last 21:04Z), plus several MV refreshes (`rpc-refresh-market-index-daily`, `rpc-refresh-topshot-pack-sales-agg`, `rpc-refresh-allday-pack-sales-agg`, `rpc-refresh-mv-ts-set-play-catalog`).
- Concurrency positive control climbed over the sweep: 4 IO / 3 active (21:06Z) → 9/14 → 8/7 → **16 IO / 17 active (21:16Z)**. Majority-in-IO-wait ⇒ spell.
- ⛔ Do NOT attribute this to a single cause here (the focus steer's five refuted levers — MV de-clustering, jobid 355, `refresh_wmc_fmv_changed`, etc. — still stand refuted). The morning's quiet-window ranking already lives in `inbox/2026-09-12T1500Z-…`. **Any durations/costs read during this spell are uninterpretable; re-measure in a quiet window before acting.**

## Everything else swept CLEAN this run

- Security: 0 public tables with RLS off · 0 anon/authenticated write grants on RLS-off tables · `check_public_security_invariants()` clean · `check_secdef_anon_execute_violations()` = `[]`.
- Vercel: newest production deploy READY; **no ERROR-state deployment** in the last 20.
- The six listings/pack-ask lanes silent since 19:32Z (snapshot-pack-asks, allday-listings-indexer/retry, golazos-listings-indexer, pinnacle-listings-retry, pinnacle-events-ingest) are **already covered** by `2026-09-12T0540Z` — the single 19:32Z second-cluster is the GHA backstop's sequential run at 8 ticks/day; not re-filed.
- `topshot-active-listings-ingest` silent ~17 h is its documented "box-dark" medium arm (residential Task Scheduler feeder) — known/expected, not re-filed.
- The three dead Top Shot lanes (`topshot-catalog-backfill`, `topshot-misattrib-drain`, `ingest-topshot-challenges`) remain `info` / suppressed — not re-filed.

Section 1b (heavy artifact payload validation) was deliberately SKIPPED this run: re-running payload queries during a spell stacks IO onto the saturation, and a timing-out payload query in a spell is a symptom, not a broken artifact. Section 1a first-tick extras skipped (mid-day tick, not the ~8am run).
