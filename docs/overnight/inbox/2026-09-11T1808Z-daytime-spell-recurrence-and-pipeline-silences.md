# Daytime monitor — 2026-09-11T18:08Z (11:08 PT)

**All items below are SYMPTOMS observed DURING a saturation spell (positive control: 26/38 active backends in IO wait). Per Section 1c none is a causal conclusion — each suggested action is a quiet-window RE-MEASURE, not a fix. Cross-references the 09-11 ledger entry, which already owns this class and is actively worked by a live Claude Code session ("Keep going. Don't stop for another hour"). Do NOT treat these as new bugs — they are the daytime data point on an already-logged, in-progress investigation.**

Written to mount, push unavailable (bash/clone mount down 3rd night per `.lock`; git path unusable this run).

## Context / not-new
- Ledger top entry (09-11) documents this exact class: recurring IO-saturation spells, `job startup timeout` bursts (M11 go-live regression), culprit hypothesis pg_cron **jobid 355** `backfill_pinnacle_trade_acquisitions(50000)` (60× variable cost, invisible on the scheduler's own instruments), and the explicit reason nothing shipped (batch must be sized on BUFFERS outside a spell). A live-session Vercel commit even records the spell *clearing* earlier today (backends 34→7) before it returned.

## Symptom 1 — spell RECURRED into an ~11:08 PT window (additive timestamp)
- **Source:** `pg_stat_activity` @ 18:08Z. Active band (all IO-bound): ~20× `refresh_wmc_fmv_changed(30,200000)` (PostgREST-wrapped), `roll_pack_ask_hourly_low()`, `rollup_pipeline_gaps(3)`, `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_topshot_*`, autovacuum `sales_2026` (9m36s). Band was only 2–10 min old at probe time (top-of-hour heavy cron overlap).
- **Value added:** confirms the spell is *recurring across multiple windows today* (ledger has 13:25Z + a "cleared" commit; this is a distinct ~18:0xZ recurrence), i.e. not a one-off — consistent with jobid 355's `23 1-22/3 * * *` cadence.
- **Suggested action:** none new — folds into the ledger's jobid-355 investigation. Re-measure the 355 batch cost with BUFFERS in a genuinely quiet window before sizing any batch cut.

## Symptom 2 — pg_cron timeout cluster (collateral, NOT N bugs)
- **Source:** `check_pgcron_recent_failures()` — ~27 jobs `failed`, **every** `last_fail_message` is `job startup timeout` or `canceling statement due to statement timeout`. **Zero logic errors.** Per CLAUDE.md: a cluster of startup/statement timeouts with no logic errors is saturation collateral, not N distinct bugs. Latest fails all in the 17:5x–18:09Z band.
- **Suggested action:** expected to clear on the next ticks once the band passes. Re-check in a quiet window; do NOT file per-job bugs.

## Symptom 3 — pipeline silences (edge/cron), same collateral
- **Source:** `detect_stalled_pipelines()`. A cluster last recorded at **16:39:18Z** (~90 min silent), same second across independently-scheduled pipelines: `allday-listings-retry`, `golazos-listings-indexer`, `pinnacle-listings-retry`, `pinnacle-events-ingest`, `snapshot-pack-asks`. Plus `ts-listings-atlas-sync` (2-min pg_cron) silent 23 min.
- **Read:** the simultaneity is a shared cron-job.org batch whose invocations are timing out under saturation and writing no `pipeline_runs` marker (so they read as silence) — consistent with the spell, NOT proven to be a separate shared-caller outage. User-facing note: `snapshot-pack-asks` feeds Pack Sniper recency, so a *sustained* silence would have blast radius.
- **Suggested action:** re-run `detect_stalled_pipelines()` in a quiet window. Only escalate if the 16:39Z cluster is STILL silent after the DB is uncontended (that would separate genuine-caller-stop from spell collateral).

## Candidate 4 — `snapshot-institutional-wallets` (the one possibly-genuine miss)
- **Source:** `detect_stalled_pipelines()` — severity **high**, silent **1922 min (~32h)** vs 1800-min (30h) threshold; last run 2026-09-10T10:07Z. Daily cron-job.org job.
- **Read:** a daily job ~2h past its grace could be a genuinely missed daily invocation OR its single daily fire landed in a spell window. Low blast radius (institutional-wallet daily snapshot).
- **Suggested action:** confirm whether its next scheduled fire lands; if it misses again, investigate the cron-job.org entry. Not urgent.

## Clean this run
- Security: `pg_tables rowsecurity=false` in public → `[]` (clean; anon/authenticated write-on-RLS-off necessarily empty).
- Vercel: newest prod deploy CANCELED (superseded by the live session's rapid docs commits — benign); no ERROR in the listing.
- Artifacts: payload validation SKIPPED this run per Section 1b spell discipline (don't stack IO; a timeout in a spell is not a broken artifact). Re-validate in a quiet window.
- First-tick-of-day extras (1a): SKIPPED — this is the ~11 PT tick, not the ~8am first tick.
