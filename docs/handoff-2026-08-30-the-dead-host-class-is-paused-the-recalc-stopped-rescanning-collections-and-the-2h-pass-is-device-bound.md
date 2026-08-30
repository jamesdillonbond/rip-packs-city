# Handoff — 2026-08-30 (desktop-VM Cowork, 02:20–04:40Z) — the collection page is fast, the dead-host class is paused, the recalc stopped re-scanning collections, and the 2h pass is device-bound

Two sessions of work in one file; the ledger carries the mechanisms (five entries dated 2026-08-29 "late"), this is the map.

## Shipped (all pushed from the VM; CI green on `eb54432`)

1. **`/api/collection-moments` 40–60 s → 1–2 s** (the cloud pass's "10 of 18 failing"). The heap-fetch hypothesis was falsified (a cron_heavy VACUUM of `fmv_snapshots_2026`, jobid 396, changed buffers by zero). Mechanisms: `LANGUAGE sql` functions are planned **param-blind** on PG 17, and `get_wallet_total_fmv` did a whole-table DISTINCT ON per call (1.37M buffers; a 30 s timeout on one collector rendered a **$0 headline**). Migrations `20260830023744`, `20260830025740`: plpgsql `RETURN (...)` + `force_custom_plan` (load-bearing), total-FMV scoped to the wallet's editions. Pinned suites re-pointed, green on PG 16.
2. **`get_fmv_for_editions`** (the #1 PostgREST consumer): LATERAL latest-per-edition instead of the `fmv_current` DISTINCT ON view (`20260830030332`, −86 % buffers). **`get_pack_realized_ev_row`**: listing key pushed into `pack_ev_latest` + index (`20260830032541`, 667,780 → 14,515 buffers).
3. **wmc index bloat** (22–49 % leaf density on 1.7 GB of indexes, 512 MB shared_buffers): one-off cron_heavy `REINDEX INDEX CONCURRENTLY` slots 08:09/08:33/10:09/10:33Z + verify/self-unschedule 10:49Z (jobids 397–401; migrations `20260830030753/030829/030917/030951`).
4. **Sentinel "5 active"** — all `public-api.nbatopshot.com` 530: cron-job.org 7526594 / 7617630 / 7658302 Inactive, six bounded suppressions (2026-09-13), three arms off (`20260830034312`). Reversible in four steps; exit condition in the migration header and the pass prompt. Trust-health is down to the one deliberately-red arm.
5. **Saturation**: instrument `public.audit_20260830_pgss_snap` (diff pg_stat_statements ON the full key). A quarter of quiet-hour DB time was `/api/fmv-recalc` re-scanning whole collections inline to haircut/clamp ~130 rows. `20260830040739` + route: `*_for_editions` twins scoped to the run's own edition ids. Live: fmv-recalc 331 s → 79–99 s; haircut 38 s → 0.4 s per run.
6. **Scheduled task**: "RPC autonomous pass (every 2h, device-bound: can push)" replaces the cloud-only one (disabled). **Needs Trevor's approval of the device-binding card** — until then it runs cloud-only with correct fallbacks.

## Watches
- Reindex slots + verify (jobids 397–401) tonight; jobid 383 10:53Z; jobid 384 hourly :23; sweeps 06:28/11:28/20:28Z; fmv-recalc `duration_ms`; pg_stat_statements means for the rewritten RPCs.

## Trevor
- Approve the device-bound task card. Set `GITHUB_ACTIONS_READ_TOKEN` (actions:read) in Vercel env (Detector Health arm). Reindex cadence (monthly?). Port-or-retire the dead-host class. #50 pool revival, #20, #34, anon TRUNCATE, wallet-backfill thresholds.
