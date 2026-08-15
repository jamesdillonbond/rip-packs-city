# Daytime monitor — 2026-08-15T15:10Z (~08:10 PT, first tick)

Environment: bash sandbox DOWN (`useradd` /sessions no-space, ~8th consecutive day) → no git clone/push. This file written to the MOUNT, push unavailable — night pass picks it up locally. Health sweep ran via the Supabase connector only.

## Loud signal (current condition, not a new defect)
**An acute platform-wide disk-IO / connection-pool saturation spell is ACTIVE right now (15:00–15:08Z).** 30 pipelines failing in the last 6h, almost all `Timed out acquiring connection from connection pool` / `canceling statement due to statement timeout` / `upstream request timeout`. Corroborated by my own instruments timing out this tick: `rpc_ops_snapshot()`, `v_rpc_trust_health`, and `check_pgcron_recent_failures()` all 57014'd. This is the documented burst-credit / 2 GB-instance class (CLAUDE.md), and the 01:05 PT night pass already logged the wave — NOT re-filing the general class. Two things worth the night pass's eyes inside it:
- **Wallet backfills are LOSING rows to lock timeouts during the spell:** `wallet-backfill-allday` rows_lost=600, `wallet-backfill-pinnacle` rows_lost=258, `wallet-backfill` rows_lost=400 (`wmc_upsert_chunk_failures` on lock timeout). Self-heals on the next successful walk, but flagging the concrete data-loss shape.
- **`refresh_wmc_fmv_changed` is now the loudest failing pipeline** (24 fails/6h; daily 08-14 ran 270× / 90 fail, 08-15 142× / 40 fail) — it stepped up hard when pg_cron jobid 303 `rpc-refresh-wmc-fmv-changed` was added, and it is the #1/#2 disk reader per CLAUDE.md. Its cadence increase is feeding the same saturation it suffers from. Already characterized in inbox `2026-08-15T0350Z`.

## NEW candidate (not in any existing inbox file)
**Title:** `cross_collection_cohort_mat` stale ~35h — `rpc-ccm-step1` failed today on statement timeout
**Source:** pg_cron `cron.job_run_details` — `rpc-ccm-step1` @ 2026-08-15 04:10Z status=**failed**, `ERROR: canceling statement due to statement timeout` on the `INSERT INTO public.cross_collection_cohort_mat` step. `cross_collection_cohort_mat` max(computed_at) = 2026-08-14 04:10Z (179 rows). Its sibling `rpc-ccm-step2` (04:25Z) **succeeded**, so `cross_collection_ts_set_overlap_mat` is fresh (08-15 04:25Z) — the INVERSE of the usual "step2 failed" pattern the runbook anticipates.
**Risk:** LOW blast radius — powers the `rpc-cross-collection` artifact + cross-collection cohort reads; one stale table, no user-facing board broken (`public_board_empty_count` = 0). Self-heals if tomorrow's 04:10 tick lands in a quieter window.
**Suggested action (night pass / Trevor):** re-run step1 off the congested 04:xx UTC anchor via a self-cleaning one-shot (recipe per task-file 1a: pg_cron one-shot for JUST step1, body ends in `cron.unschedule` of itself; a FAILED one-shot does NOT self-unschedule — clean next day). If it keeps timing out, the cohort INSERT needs a longer `statement_timeout` or the same partition/predicate treatment the entity-page timeouts got — it is a growing daily refresh colliding with the 04:xx saturation window, not a transient.

## Everything else — clean / known
- **Security:** `check_public_security_invariants()` null, `check_secdef_anon_exec_drift()` [], RLS-off 0. DB 13 GB.
- **Stalled pipelines (2), both expected per their own watchlist notes:** `candy-listings-indexer` (known runs-but-does-not-log defect; `candy_listings.last_seen_at` was fresh) and `allday-pack-opens-backfill` (finite spork walk near its floor).
- **Trust board:** precompute fresh; known-class breaches only — `public_board_slow_count` 9, `panini_sale_price_capture_dry_days` 18 (both documented). Live view timed out this tick (saturation), so `fmv_sweep_wedge_hours` not re-read — it is the documented open breach.
- **fmv-recalc degradation confirmed ongoing** (08-14 runs 93→41 / rows 45k→10.7k; 08-15 40 runs / 18,720 rows) — already the headline live-side item in CLAUDE.md + inbox.
- **Sentry:** 2 new/24h, both single-event `smoke check could not run` self-notices (NEXTJS-2A/2B, `GET /api/smoke-test`) — low severity, not a spike.
- **Vercel:** no ERROR/CANCELED deploys in the recent 20; tip is BUILDING (a Claude `fix(fmv/demo)` commit — the state-lag caveat applies, not a finding).

## Skipped this tick
- **Artifact validation (1b):** deliberately SKIPPED — running the heavy per-artifact payload queries during an active pool-exhaustion spell would worsen it and almost certainly time out (the merged-payload dashboards read the same saturated views). Re-validate next tick once the spell clears; `public_board_empty_count` = 0 says no board is outright broken.
- **Inbox commit:** shell down → written to mount only, unpushed.
