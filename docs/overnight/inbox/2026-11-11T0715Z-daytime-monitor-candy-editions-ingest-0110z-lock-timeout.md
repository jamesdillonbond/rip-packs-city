# Daytime monitor — 2026-11-11 ~07:10Z (23:10 PT 11-10) — 1 candidate

Read-only daytime health pass (Cowork cloud, lock stale/RELEASED). GREEN overall:
security `[]`/`[]`/`[]`/`[]`, `stalled_pipelines []`, `sentinel_ts_uuid_editions_48h 0`,
13/13 live dashboards' SQL objects resolve (roster reconciled, no new `docs/cowork-skills/*.html`),
Vercel production serving latest **app** code (last READY `aacfefdeb` 01:46Z; the 6 newer prod
deploys are CANCELED but diff `aacfefdeb..HEAD` is docs + one migration-record only — the
documented `vercel-docs-only-tip-commit-skips-code-deploy` behavior, no stranded code),
runtime-error tail is single-occurrence timeouts on known-heavy routes (no spike). NOT in a
saturation spell (snapshot + all reads fast). This is a ~23:10 PT tick, not the ~8am tick, so the
first-tick-of-day extras (1a) were not run.

**Already queued / tracked — NOT re-raised here:**
- `fmv-backfill` 60 s statement-timeout on ~1/3 of runs + `wallet-backfill-continuation` HIGH on
  the already-recovered #245 lane — both in `2026-11-11T0112Z-daytime-monitor-...md`. (Confirmed
  still true this pass: continuation last failed 22:11Z 11-10 pre-fix, `wallet-backfill-resume`
  100% green every 10 min 03:53Z→07:03Z; fmv-backfill last fail 00:35Z pre-dates the 01:46Z
  `20261111014609` pin.)
- `edition_integrity_flags` BREACH (10,372) — #246 Candy name-only repair, focus steer says
  expected to fall over ~1-2 days; watch (`wmc_repointed` > 0). Not new.
- `rpc-chain-arrivals-seed` pg_cron fail 11-10 11:13Z — pre-dates the 17:03Z fix
  (`20261110170308`), stale pre-fix run, clears on today's 11:13Z tick. Focus watch item.
- Atlas 403/404/400 `info` alert rows — by-design upstream-challenge attribution, escalation
  thresholds not met.

## 1. (MEDIUM, low-risk) `candy-editions-ingest` fails every day at the 01:10Z tick on a `wallet_moments_cache` lock timeout, self-heals at 04:10Z

- **Source:** `pipeline_runs` pipeline='candy-editions-ingest', last 30 h. Pattern is stable across
  two days: 11-11 01:10:49Z FAIL / 04:10:49Z OK; 11-10 01:10:49Z FAIL / 04:10:49Z OK. Error each
  time: `1 rejected write(s): wallet_moments_cache: canceling statement due to lock timeout`.
  Shows in `rpc_ops_snapshot().pipeline_alerts` as MEDIUM (`2/5 runs failed (40.0%)`).
- **What it is:** the 01:10Z run collides with another writer holding a lock on
  `wallet_moments_cache`; the 04:10Z run has a clear window and succeeds. The census ⋈ wmc
  contention was declared CLOSED in the ledger, but this specific 01:10Z ingest tick still tips
  the lock-timeout. Only the one daily tick fails and the next run re-ingests, so no data is lost —
  but it keeps the MEDIUM arm flapping and masks a genuinely-new candy-editions failure if one
  ever lands at 01:10Z.
- **Risk read:** low-risk to investigate (read-only). No user-facing surface; a dropped 01:10Z
  cycle is re-picked at 04:10Z.
- **Suggested action (night pass / quiet window):** identify the writer holding
  `wallet_moments_cache` at ~01:10Z (likely an overlapping cron — check `cron.job` schedule near
  :10 past the hour and the 01:10Z `pg_stat_activity` blocker chain if reproducible), then either
  stagger the 01:10Z candy-editions-ingest tick off the collision, or give its `wallet_moments_cache`
  write a short retry / `SKIP LOCKED` path the way `wmc-fmv-stuck-resync` already carries. Do not
  conclude the lock holder from a single probe — confirm across a couple of 01:10Z ticks.
