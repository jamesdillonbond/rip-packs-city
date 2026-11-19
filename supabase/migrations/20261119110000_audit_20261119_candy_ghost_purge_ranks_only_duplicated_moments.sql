-- audit_20261119_candy_ghost_purge_ranks_only_duplicated_moments
--
-- 2026-11-19 (PT, morning by DB clock; Claude Code cloud; Trevor: "Keep going and make your own decisions")
-- -- inbox 2026-11-19T1605Z (daytime monitor).
-- purge_candy_wmc_ghost_rows() (pg_cron rpc-candy-wmc-ghost-purge, 1:10 AM PT daily) window-ranked EVERY
-- Candy wallet_moments_cache row (~1.37M) to find the few superseded ones. Runs took 70-109 s for 10 days
-- against its 120 s statement_timeout and failed at 120 s on 11-19. Measured today: the ranked read alone
-- ran >64 s (cancelled); `GROUP BY moment_id HAVING count(*) > 1` over the same rows: 10.4 s, 7 moments.
--
-- WHAT. Same function, same invariants (newest row per moment survives; Candy-scoped; single rows never
-- touched): find the duplicated moment_ids first, then rank and delete only within them. Exactly
-- equivalent -- a moment with one Candy row has no rn > 1. Pinned by supabase/tests/purge_candy_wmc_ghost_rows.sql
-- (unchanged assertions) + the drift guard (re-pointed here). Live body before: md5 b8b71bdf (= 20260815203600).
--
-- REVERT: re-create from 20260815203600_audit_20260815_snapshot_purge_candy_wmc_ghost_rows.sql.

CREATE OR REPLACE FUNCTION public.purge_candy_wmc_ghost_rows()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_deleted integer := 0;
  v_ids     text[];
BEGIN
  -- Deliberate, scoped opt-in past rpc_guard_block_destructive: this function only ever
  -- deletes rows that are provably superseded by a newer row for the SAME moment_id.
  PERFORM set_config('rpc.allow_bulk_delete', 'on', true);

  -- 2026-11-19: only a moment with a SECOND Candy row can hold a superseded one, so find those
  -- first (an index-only pass, ~10 s) and rank just them. Ranking all ~1.37M Candy rows took
  -- 70-109 s a day and hit this function's 120 s timeout on 11-19 (7 duplicated moments found).
  SELECT array_agg(d.moment_id) INTO v_ids FROM (
    SELECT moment_id
      FROM public.wallet_moments_cache
     WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
     GROUP BY moment_id
    HAVING count(*) > 1
  ) d;
  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY moment_id ORDER BY last_seen_at DESC) AS rn
    FROM public.wallet_moments_cache
    WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
      AND moment_id = ANY (v_ids)
  ), del AS (
    DELETE FROM public.wallet_moments_cache w
    USING ranked r
    WHERE w.id = r.id AND r.rn > 1
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_candy_wmc_ghost_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_candy_wmc_ghost_rows() TO service_role;
