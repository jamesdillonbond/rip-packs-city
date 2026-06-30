# Handoff 2026-06-10 — DBSAT root cause: wmc full-rewrite storm. Change-detecting upsert RPC + 202-wrap sweep + badge-taxonomy cache

## Context

Cowork measured the DB-saturation disease behind tonight's alert flood (30s cron timeouts across ~10 entries, statement-timeout pipeline fails, the 06:55Z wallet-backfill 5xx spikes, badge-taxonomy 5xx spike, Pipeline Sentinel/Ops Monitor GHA reds). Nothing was shipped for this item from Cowork — the RPC and its callers must land together in one CC session (you have the Supabase MCP; apply the migration yourself right before the route swap). HEAD at write time: 50acf94-era (post reconcile-wrap + footer). The reconcile 202-wrap (56ad4ff) is the pattern reference throughout.

Root cause, measured (pg_stat_statements):
- #1 query: PostgREST INSERT INTO wallet_moments_cache ... ON CONFLICT (the wallet-backfill batch upsert) — 37,615 calls, MEAN 4.0s, max pegged at the 8s statement cap, 150,723s total DB time. A twin entry adds 15,356 calls at 4.1s mean.
- Why: every call site includes last_seen_at: now() in the payload, so EVERY conflicting row always differs -> full row rewrite + maintenance of every wmc index + the per-row trg_normalize_tier_wmc trigger, for ~1.58M rows, EVERY 6h wave. On Micro compute that exhausts IO for hours; everything else times out as collateral.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Item 1 (HIGH) — change-detecting wmc batch-upsert RPC + swap the 4 call sites

File: lib/chains/flow/wallet-backfill-helpers.ts — verified call sites: .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" }) at ~L362, ~L581, ~L789, ~L1180. Verified payload fields (union across sites): wallet_address, collection_id, moment_id, edition_key, serial_number, tier, player_name, set_name, character_name (Pinnacle site only), series_number, acquired_at, fmv_usd, last_seen_at. (The on_chain_count / skip_cached tokens near L330 are outer-scope args, NOT row fields.)

New SECDEF RPC (apply via MCP as audit_20260610_upsert_wmc_batch_change_detect), shape:

create or replace function public.upsert_wmc_batch(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public set statement_timeout = '120s' as $$
declare v_inserted int; v_updated int; v_total int;
begin
  create temp table if not exists _wmc_in (like ...) -- per the repo's set-oriented batch pattern: DROP TABLE IF EXISTS first (memory: plpgsql-row-by-row-batch-rewrite-pattern)
  -- 1. jsonb_to_recordset(p_rows) into the temp table (columns above, all nullable except the 3 key parts)
  -- 2. INSERT INTO wallet_moments_cache (...) SELECT ... FROM _wmc_in
  --    ON CONFLICT (wallet_address, collection_id, moment_id) DO UPDATE SET
  --      edition_key = excluded.edition_key, serial_number = excluded.serial_number,
  --      tier = excluded.tier, player_name = excluded.player_name, set_name = excluded.set_name,
  --      character_name = coalesce(excluded.character_name, wallet_moments_cache.character_name),
  --      series_number = excluded.series_number, acquired_at = excluded.acquired_at,
  --      last_seen_at = excluded.last_seen_at
  --    WHERE wallet_moments_cache.edition_key    IS DISTINCT FROM excluded.edition_key
  --       OR wallet_moments_cache.serial_number  IS DISTINCT FROM excluded.serial_number
  --       OR wallet_moments_cache.tier           IS DISTINCT FROM excluded.tier
  --       OR wallet_moments_cache.player_name    IS DISTINCT FROM excluded.player_name
  --       OR wallet_moments_cache.set_name       IS DISTINCT FROM excluded.set_name
  --       OR wallet_moments_cache.series_number  IS DISTINCT FROM excluded.series_number
  --       OR wallet_moments_cache.last_seen_at < now() - interval '24 hours'
  -- 3. return jsonb_build_object('total', v_total, 'written', v_updated_plus_inserted)
end $$;

The two load-bearing semantics, in priority order:
1. The WHERE on DO UPDATE is the entire point: an unchanged row whose last_seen_at is <24h old is SKIPPED (no rewrite, no index churn, no trigger). The weekly wmc cleanup window is 7 days, so 24h liveness granularity is semantically identical for it — verify that claim against run_weekly_db_maintenance's actual predicate before relying on it.
2. Enrichment-column preservation: fmv_usd, image_url, mint_count, render_id etc. are written by OTHER pipelines (wmc-fmv-populate, populate_wmc_image, the render_id re-key). The RPC's UPDATE list must NOT include them — with one decision point: **fmv_usd is in the current payloads. INSPECT what the call sites actually pass.** If it's null/undefined in practice, drop it from the RPC entirely AND note that the legacy .upsert() may have been silently nulling wmc.fmv_usd every wave for wmc-fmv-populate to re-fill (hidden churn — measuring its disappearance is a bonus win). If it's genuinely populated on some path, keep it with coalesce + add it to the change predicate.

Grants (the SECDEF footgun): REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role. Verify post-apply.

Route swap: replace each .upsert(chunk, ...) with supabase.rpc("upsert_wmc_batch", { p_rows: chunk }) preserving each site's error handling. Keep chunk sizes as-is initially. Rollout: apply migration -> swap ONE site (suggest the TS one at ~L362) -> tsc -> deploy -> watch one wave (wmc writes still land, pipeline_runs clean, no fmv_usd wipe) -> swap the remaining 3.

Revert: git revert (routes) + DROP FUNCTION public.upsert_wmc_batch(jsonb);

Expected metric: wmc upsert mean 4,000ms -> low hundreds; the 06:55Z-class wallet-backfill 5xx storms stop; statement-timeout fails across unrelated pipelines (pack-ev, nft-resolver, hydrator, check-alerts) drop sharply on the next 6h waves (00/06/12/18Z).

## Item 2 (HIGH, mechanical) — 202+after() wrap sweep, 9 verified sync routes

All verified present, zero after() usage, currently sync — each one is a future cron-job.org auto-disable (the reconcile incident class) during any long saturation window. Mirror 56ad4ff exactly: auth stays sync, body+log_pipeline_run into after(), immediate 202.

- app/api/check-alerts/route.ts (maxDuration 60) — alerting monitor; wrapping is safe because its real signal is the Telegram/email sends + pipeline_runs, not HTTP status.
- app/api/admin/drain-fmv-cold-tail/route.ts (60)
- app/api/cron/offers-sweep/route.ts (300)
- app/api/cron/backfill-pack-rip-metadata/route.ts (60)
- app/api/cron/refresh-pack-grail-metrics-mv/route.ts (60)
- app/api/cron/backfill-pack-pull-source-rip-id/route.ts (300)
- app/api/cron/daily-portfolio-snapshot/route.ts (300)
- app/api/admin/apply-fmv-haircut/route.ts (300)
- app/api/admin/backfill-pinnacle-catalog/route.ts (120)

Also locate and include the route behind the "RPC Refresh Error Triage" cron (app/api/admin/cron/refresh-error-triage/ exists; verify which path the cron entry hits) and the classify-acquisitions cron target (candidates: app/api/classify-acquisitions/, app/api/bulk-classify/ — match by the cron entry URL in docs/operations/cron-schedule.md or the dashboard).

The 300-maxDuration ones (portfolio snapshot, fmv-haircut, offers-sweep, pack-pull backfill) by definition can exceed the 30s client cap on a healthy day — they've been dashboard-red/server-green all along; the wrap fixes that lie too.

Revert: git revert per commit. Expected: cron dashboard goes green across the board on the next ticks; no entry can accumulate a failure streak.

## Item 3 (MED) — badge-taxonomy module-level cache

File: app/api/badge-taxonomy/route.ts (verified: POST, thin wrapper over get_badge_display_metadata RPC, NO caching). Badge taxonomy is near-static. Add a module-level Map cache keyed by the normalized-title set (or just cache the full taxonomy on first miss) with ~1h TTL, and serve the stale cache on DB error instead of 5xx. Kills the 126-fails/5min Sentry spike class — during waves this route should not touch the DB at all for repeat lookups.

## Item 4 (LOW) — CI cadence-lint red

scripts/extract-cadence.mjs runs clean on the current tree (verified tonight, exit 0, fixture written). The GHA failure is therefore in the workflow's flow-CLI step or transient — re-run the workflow first; only dig if it stays red.

## NOT in this handoff

- Supabase compute upgrade (Micro -> next tier): Trevor decision; the evidence (heterogeneous statement timeouts at 22 conns, 0 lock waits, recurring multi-hour windows) says load has outgrown Micro even after Item 1 lands.
- GSC indexing reasons: separate SEO bucket; the 404 class deserves its own look later.
- wallet-backfill-multicollection-complete cron_silent HIGH: known telemetry artifact, ledger-carried.

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s.
- CRLF: full-file writes or findIndex on split lines; no string-replace patches.
- CREATE OR REPLACE FUNCTION resets grants — re-assert service_role-only every time.
- Run the smoke test after deploy; ledger the ships with revert paths.

## End state

Migration + 2-3 commits on main, deploy READY: wmc waves write only changed/once-daily rows (instance-wide statement timeouts subside), no cron route can be auto-disabled by a saturation window, badge-taxonomy serves from memory, CI green. Trust health + the cron dashboard stay green through the next 00/06/12/18Z waves.
