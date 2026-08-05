-- audit_20260805_retire_deposit_scanner_ownership_scaffold
--
-- Retires the abandoned TopShot/AllDay Deposit-event ownership-scanner scaffold
-- (docs/code-todos.md #2, deep-dived in docs/handoff-2026-07-31-ownership-scanner-todo-deepdive.md).
--
-- Why this is safe (all re-verified live 2026-08-05 before applying):
--   * topshot_ownership_snapshots = 1 test row; allday_ownership_snapshots = 0 rows.
--   * The 4 topshot/allday `*-deposit-scan-*` cursors in flow_backfill_progress have
--     been frozen at height 150585016 since 2026-05-05 (0 events ever). The scanner
--     edge function they were staged for was never built.
--   * The scanner was SUPERSEDED for TopShot by the live two-pipeline design
--     (sync-topshot-ownership-dune + ownership-onchain-walk -> topshot_ownership,
--     267,742 rows, fresh 2026-08-04, consumed by lib/set-completers-board.ts).
--   * Dependency scan (pg_proc bodies, pg_views, pg_matviews, cron.job, triggers,
--     inbound FKs, and a full code grep) found ZERO consumers of any object dropped
--     here EXCEPT resolve_special_serials_from_ownership(), which reads the two
--     snapshot tables and is itself dormant (called by no code/route/cron/function).
--     It is dropped in the SAME migration so no function is left erroring.
--
-- NOT touched (shared / live infra):
--   * scanner_get_progress() / scanner_advance_progress() -- generic over
--     flow_backfill_progress, reusable by a future scanner. KEPT.
--   * flow_backfill_progress TABLE and the LIVE pinnacle-deposit-scan* cursors. KEPT
--     (the DELETE below is scoped to the 4 frozen topshot/allday cursor rows only).
--   * topshot_ownership, special_serial_holders/_targets, special-serial-sweep,
--     refresh_topshot_special_serial_owners_mv -- the LIVE paths. KEPT.
--
-- Revert path: git revert the code commit, then re-apply the DDL captured verbatim
-- in the trailing comment block of this file (these objects were originally applied
-- via MCP and were never committed as migration files, so there is no prior file to
-- restore -- the block below IS the source of record).

BEGIN;

-- Drop the dormant reader FIRST (reads the snapshot tables being dropped).
DROP FUNCTION IF EXISTS public.resolve_special_serials_from_ownership(text, integer);

-- Drop the never-wired batch upsert RPCs.
DROP FUNCTION IF EXISTS public.upsert_topshot_ownership_batch(jsonb);
DROP FUNCTION IF EXISTS public.upsert_allday_ownership_batch(jsonb);

-- Drop the empty/test-only snapshot tables (no inbound FKs; verified).
DROP TABLE IF EXISTS public.topshot_ownership_snapshots;
DROP TABLE IF EXISTS public.allday_ownership_snapshots;

-- Remove only the 4 frozen topshot/allday deposit-scan cursor rows.
-- (Pinnacle's live cursors + the shared table are intentionally untouched.)
DELETE FROM public.flow_backfill_progress
 WHERE id IN ('topshot-deposit-scan-forward','topshot-deposit-scan-backward',
              'allday-deposit-scan-forward','allday-deposit-scan-backward');

COMMIT;

-- ============================================================================
-- REVERT DDL (verbatim capture, 2026-08-05) -- re-run to restore the scaffold.
-- ============================================================================
-- CREATE TABLE public.topshot_ownership_snapshots (
--   nft_id text PRIMARY KEY,
--   owner text,
--   deposit_block_height bigint,
--   observed_at timestamptz
-- );
-- ALTER TABLE public.topshot_ownership_snapshots ENABLE ROW LEVEL SECURITY;
--
-- CREATE TABLE public.allday_ownership_snapshots (
--   nft_id text PRIMARY KEY,
--   owner text,
--   deposit_block_height bigint,
--   observed_at timestamptz
-- );
-- ALTER TABLE public.allday_ownership_snapshots ENABLE ROW LEVEL SECURITY;
--
-- INSERT INTO public.flow_backfill_progress (id, last_processed_height, updated_at)
-- VALUES ('topshot-deposit-scan-forward',150585016,'2026-05-05 15:05:00+00'),
--        ('topshot-deposit-scan-backward',150585016,'2026-05-05 15:05:00+00'),
--        ('allday-deposit-scan-forward',150585016,'2026-05-05 15:05:00+00'),
--        ('allday-deposit-scan-backward',150585016,'2026-05-05 15:05:00+00');
--
-- The three SECURITY DEFINER functions (upsert_topshot_ownership_batch(jsonb),
-- upsert_allday_ownership_batch(jsonb), resolve_special_serials_from_ownership(text,
-- integer DEFAULT 200)) -- each `SET search_path TO 'public'` -- are recoverable
-- verbatim from this session's transcript and from git history prior to this commit.
-- Their bodies were: the two batch RPCs = jsonb-array -> DISTINCT ON (nft_id) latest
-- deposit_block_height wins -> INSERT ... ON CONFLICT (nft_id) DO UPDATE ... WHERE
-- existing.deposit_block_height < EXCLUDED.deposit_block_height; the resolver =
-- special_serial_targets JOIN nft_edition_map JOIN <collection>_ownership_snapshots
-- -> upsert special_serial_holders (gated to nba_top_shot / nfl_all_day).
-- ============================================================================
