# Daytime monitor — 2026-08-10T21:07Z

Written by `rpc-daytime-monitor`. Shell/git down (the `/sessions` no-space `useradd` failure, 3rd+ consecutive night) — **inbox written to mount, push unavailable**; night pass picks it up locally. Sweep otherwise clean: security 4/4 `[]`, DB 12,423 MB, deploys no-ERROR (latest READY `05ac4ba2`), artifact estate healthy (13 board surfaces + core objects resolve, no schema break from today's `get_collection_stats`/`get_set_detail`/`allday_scarcity_board`/liveness-prune ships).

**Known / already-queued, NOT re-raised:** 3 trust breaches all carried — `panini_sale_price_capture_dry_days`=13 (residential home-box outage), `public_board_slow_count`=5 (queued today: inbox `1900Z`/`1930Z`/`1700Z`), `unmapped_resolution_backlog_max`=194 (permanent AllDay backfill-inflow floor). Sentry `JAVASCRIPT-NEXTJS-26` (edition-page schema-cache/pool timeouts, 16 events/1 user, last seen 5h ago) = saturation collateral, dispositioned in CC's `1509Z` archive. `rpc-reconcile-saved-wallet-stats` pg_cron fail @13:33Z **PREDATES** CC's same-day resumable-procedure fix (~16:00Z, `de6af070`) → STALE pre-fix run, clears on tomorrow's 13:33Z tick — not a finding. The other pg_cron timeouts (`rpc-ccm-step2`, `rpc-refresh-misattrib-candidates`, `rpc-thin-sale-ask-disclosure-refresh`) are the documented disk-IO-saturation MV-refresh cluster.

---

## Candidates

### 1. LOW — `pinnacle-sync` now on its 2nd consecutive daily miss (~35h silent), extends today's single-miss disposition
- **Source:** `rpc_ops_snapshot()` `stalled_pipelines` + `pipeline_alerts` — last successful run 2026-08-09 10:07Z, silent 2,099 min vs 1,560 threshold (24h cadence, 26h fuse). External cron-job.org tick.
- **Context:** CC's `1509Z` archive dispositioned this as LOW on a *single* miss because catalog freshness is covered by the 08-08 Vercel backstop (`/api/admin/backfill-pinnacle-catalog` @21:37Z, ran today 09:37Z ok/2,457 rows) and Pinnacle FMV is on separate pg_cron. That coverage still holds — `pinnacle_render_floor_stale_hours`=1.3 (ok), `pinnacle_fmv_stale_hours`=22.5 (ok, breach 30) but **climbing**.
- **Risk read:** LOW — impact still backstop-covered; the cron-job.org entry itself has now been dead ~2 days, which is operator-side (external console). The single-miss "not escalated" disposition no longer strictly holds at two misses.
- **Suggested action:** night pass — note only; no autonomous fix (external cron-job.org tick, operator-gated). If `pinnacle_fmv_stale_hours` crosses ~30 it becomes a real freshness breach — worth an operator poke to re-enable the cron-job.org pinnacle-sync trigger. Nothing to ship from code.

### 2. LOW — `rpc-refresh-allday-pack-realized` (pg_cron) failing 3/4 in window, sharper than "intermittent"
- **Source:** `check_pgcron_recent_failures()` — `refresh materialized view concurrently public.mv_allday_pack_realized` canceling on statement timeout, last_run 2026-08-10 18:35Z, 3 of 4 recent runs failed.
- **Risk read:** LOW / internal — same disk-IO-saturation MV-refresh class as the queued `rpc-refresh-misattrib-candidates` (nc1, 08-08) and `rpc-thin-sale-ask-disclosure-refresh`; self-recovers on a quiet tick, no user-facing surface reads a stale `mv_allday_pack_realized` critically (pack-realized board tolerates staleness). Named here because a 75% same-job fail rate is worth folding into the standing MV-optimization queue rather than treating as one-off noise.
- **Suggested action:** night pass — add to the MV-refresh index/stagger optimization set (do NOT bump the statement timeout — the documented wrong lever; the fix is cutting the refresh's query weight or moving it off the saturated `:35`-past pileup, per the 08-08 MV-cluster handoffs). CONCURRENTLY index work is operator/quiet-window-gated.
