# Daytime monitor — 2026-08-21T15:05Z (≈08:05 PT, first tick of day)

Written to the MOUNT, push unavailable (`remote.origin.pushurl` ABSENT on desktop Cowork — harvest is dead here per CLAUDE.md; only the public `remote.origin.url` is set, no creds). Night pass picks this up locally. Lock present but marked RELEASED (08-20T08:15Z by the nightly pass, stale >45min) — no concurrency skip.

⚠ **SEVERE saturation spell, afternoon-peak phase.** Positive control (§1c): **io_wait 31 / active 30 / total 46** — strict majority in IO wait. `rpc_ops_snapshot()` timed out on `sentinel_fmv_confidence_rows`. Per §1c, no heavy payload/artifact/trust-view re-runs this tick; findings below are SYMPTOMS, causal claims deferred to a quiet-window re-measure. This matches the documented intraday pattern (afternoon saturated) and the 08-20 nightly + 08-21 0309Z tick.

## Confirmed clean this tick (read-only, interpretable during the spell)

- **Security:** `public_tables_rls_off = 0`, `anon_write_on_rls_off = 0`. Clean.
- **Sentry:** 0 new unresolved issues in 24h.
- **Vercel:** production tip `fix(ingest): throw on a non-2xx event fetch` **READY** (08-21 14:48Z). `main` advanced ~15 commits today via a push-capable interactive session (01:45Z→14:48Z); **no ERROR deploys** in the window — the CANCELED ones are expected docs-only `ignoreCommand` skips. (The standing "git push dead" note is a sandbox-only limitation; interactive pushes are landing fine.)

## The one additive, NON-duplicate signal (SYMPTOM — quiet-window re-measure, NOT a causal conclusion)

**Cross-collection MV is now on its 4TH consecutive failed cycle** — up from the "3rd" recorded in the 08-20 nightly ledger. Both mats still stuck at **2026-08-17 04:10Z / 04:25Z (~4.4 days stale)**; cohort rows stable at **179** (no data loss, read-only freshness miss on `/insights/cross-collection`). Today's `rpc-ccm-step1` (04:10Z) and `rpc-ccm-step2` (04:25Z) **both failed on `canceling statement due to statement timeout`**.

- **Source:** pg_cron `check_pgcron_recent_failures()` + direct `max(computed_at)` reads on `cross_collection_cohort_mat` / `cross_collection_ts_set_overlap_mat`.
- **Why this is additive, not a re-file of `2026-08-19T1511Z` CANDIDATE 1:** the owned recovery recipe is "run a self-cleaning per-step one-shot pg_cron job in a quiet window." But 04:10Z UTC (≈21:10 PT) is a relatively low-traffic hour, and step1 has now **failed there 4 cycles running** — so the recovery's core assumption (the refresh will complete if simply retried off the afternoon peak) has NOT been validated and may be false. If step1's `INSERT ... GROUP BY` over the cohort has genuinely outgrown a quiet-window budget, the fix is a refresh RESTRUCTURE (fan-out / narrower scope), not a retry one-shot.
- **Risk:** LOW to observe. The recovery action itself is NOT low-risk mid-spell — `refresh_cross_collection_cohort_step1` opens with `TRUNCATE` (ACCESS EXCLUSIVE); a rebuild that times out after the TRUNCATE leaves the public board empty (per 08-20 nightly). Do NOT run mid-day/mid-spell.
- **Suggested action (night pass / Trevor, quiet window only):** before scheduling the one-shot recovery, first **`EXPLAIN`-cost step1's INSERT and confirm it can complete inside the role timeout at a genuinely quiet hour**. If it can't, escalate from "retry" to "restructure the refresh." Re-measure in a quiet window before drawing any cause — this observation is spell-adjacent and durations are uninterpretable now.

## Confirmed, NOT re-raised (already owned — avoid inbox duplication)

- **pg_cron timeout cluster** (this tick: ~26 jobs with `statement timeout` / `job startup timeout`, **zero logic errors**) — the saturation-collateral signature, one root cause, owned. Includes `rpc-reconcile-saved-wallet-stats`, `rpc-refresh-unmapped-backlog-growth`, `rpc-backfill-historical-pack-ev`, and the MV-refresh family. Not N distinct bugs.
- **`detect_stalled_pipelines()` cluster** (candy-editions-ingest, weekly-db-maintenance, pinnacle-sync marginal, compute-golazos-pack-ev, candy-listings-indexer cry-wolf, backfill-pack-rip-metadata, classify-acquisitions-multicollection, refresh-pack-grail-metrics-mv, reconcile-saved-wallet-stats, wallet-username-resolver, allday-lock-refresh, topshot-moments-hydrator) — dominated by spell collateral + documented known-class oscillators/standbys. No new stop.
- **08-18 `reconcile-saved-wallet-stats` post-ship watch** (backlog climbing, saturation not ship fault, do NOT revert) — owned by 08-20 nightly ledger.
- **Demand** — not re-captured this tick (heavy read, spell); last confirmed 21 users / 1 WAU (08-20). No change assumed.

The lever for the underlying saturation remains cutting work (page size / precompute / fan-out), never raising a timeout or the tier (focus §3).
