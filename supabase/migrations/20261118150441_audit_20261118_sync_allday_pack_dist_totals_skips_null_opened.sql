-- audit_20261118_sync_allday_pack_dist_totals_skips_null_opened
--
-- 2026-11-18 (Claude Code cloud; item C of docs/handoff-2026-11-18-overnight-pass.md).
--
-- WHAT BROKE. `rpc-sync-allday-pack-dist-totals` (pg_cron `24 * * * *`) failed every
-- hour from ~6:24 PM PT 11-17 to ~3:24 AM PT 11-18 with
--   null value in column "total_opened" of relation "pack_distributions" violates
--   not-null constraint
-- `expire_allday_dist_opened_drifted()` deliberately NULLs
-- `allday_pack_supply.opened_count` to re-queue a drifted distribution for the
-- hydrator. While Dapper Studio returned 530s (from ~4:23 PM PT 11-17) the hydrator
-- could not refill it. This function then copied the NULL into a NOT NULL column,
-- and because it is one UPDATE, that single row aborted the write for EVERY All Day
-- distribution. It cleared by itself once the hydrator caught up.
--
-- THE FIX. Skip a row whose opened_count is NULL (`AND i.opened_count IS NOT NULL`),
-- keeping the prior totals until the hydrator refills it.
-- ⛔ NOT `coalesce(i.opened_count, 0)`: that would publish "0 opened" for a pack whose
-- count is merely being re-read, which is a false depletion figure a collector buys on.
-- A real ZERO-opens count is NOT NULL and is still written (the D-UNOPENED case), so
-- never-ripped packs do not freeze.
--
-- Pinned: supabase/tests/sync_allday_pack_dist_totals.sql (new case D-NULLOPEN) and
-- the drift-guard entry in __tests__/db-invariants-drift-guard.test.ts.
-- anon-exec: intentional — no change: CREATE OR REPLACE keeps the existing ACL, which grants EXECUTE only to postgres, service_role and cron_heavy (the pg_cron caller); anon and authenticated have none, read live 2026-11-18 (sync_allday_pack_dist_totals)
--
-- REVERT: re-apply the body from
-- 20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql
-- and re-point the pin.

CREATE OR REPLACE FUNCTION public.sync_allday_pack_dist_totals()
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH upd AS (
    UPDATE pack_distributions pd
    SET total_minted = i.packnft_total,
        total_opened = i.opened_count,
        updated_at = now()
    FROM v_allday_pack_info i
    WHERE pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      AND pd.dist_id::text = i.dist_id
      AND coalesce(i.packnft_total,0) > 0
      AND i.opened_count IS NOT NULL
      AND (pd.total_minted IS DISTINCT FROM i.packnft_total
        OR pd.total_opened IS DISTINCT FROM i.opened_count)
    RETURNING 1
  ) SELECT count(*)::integer FROM upd;
$function$;
