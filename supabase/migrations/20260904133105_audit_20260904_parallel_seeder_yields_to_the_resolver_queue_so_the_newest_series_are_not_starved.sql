-- audit_20260904_parallel_seeder_yields_to_the_resolver_queue_so_the_newest_series_are_not_starved
-- Applied to prod via MCP apply_migration 2026-09-04 13:31Z (version 20260904133105).
--
-- Follow-up to 20260904133011 (the parallel seeding gap), measured immediately after its first tick.
-- The pending queue was EMPTY before that tick (0 rows) and the first pass added 3,919, which says
-- two things: the gap is large, and the resolver was not starved before. But
-- `get_topshot_subedition_targets` picks `ORDER BY nft_id ASC` — lowest first — and the backlog this
-- seeder finds is OLD Moments, so an unbounded fill would sit permanently in front of the
-- recent-series seeder's rows (15,000/day, the arm that catches live collisions in the sets people
-- are actually ripping). The edge fn resolves ~15,000/day, so the queue is the shared resource.
--
-- FIX: the seeder yields — it seeds nothing while the pending queue is at or above `p_queue_cap`
-- (default 10,000, two-thirds of a day's resolution, leaving headroom for the daily 15,000). It
-- therefore fills only the slack, the backlog drains over weeks instead of months of starvation,
-- and the cursor does not advance on a yielded tick so no base is skipped.
-- anon-exec: no — writer; the REVOKE/GRANT below is re-stated (CREATE OR REPLACE keeps the acl).
-- Verified after apply: ONE overload (`p_bases, p_max_rows, p_queue_cap`),
--   acl {postgres,service_role,cron_heavy}, check_secdef_anon_execute_violations() = 0.
-- REVERT: re-create the 2-arg body from 20260904133011 and re-point the cron command at it.

CREATE OR REPLACE FUNCTION public.seed_topshot_parallel_base_targets(p_bases integer DEFAULT 60, p_max_rows integer DEFAULT 4000, p_queue_cap integer DEFAULT 10000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cursor text;
  v_next   text;
  v_bases  integer := 0;
  v_seeded integer := 0;
  v_queue  integer;
BEGIN
  SELECT count(*)::int INTO v_queue FROM public.topshot_moment_subeditions WHERE subedition_id IS NULL;
  IF v_queue >= GREATEST(p_queue_cap, 0) THEN
    RETURN jsonb_build_object('skipped', 'queue_full', 'pending', v_queue, 'cap', p_queue_cap);
  END IF;

  INSERT INTO public.topshot_parallel_seed_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT cursor_base INTO v_cursor FROM public.topshot_parallel_seed_state WHERE id = 1;

  DROP TABLE IF EXISTS _par_bases;
  CREATE TEMP TABLE _par_bases ON COMMIT DROP AS
    SELECT DISTINCT split_part(e.external_id, '::', 1) AS base
      FROM public.editions e
     WHERE e.collection_id = v_ts
       AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
       AND split_part(e.external_id, '::', 1) > v_cursor
     ORDER BY 1
     LIMIT GREATEST(p_bases, 1);
  SELECT count(*), max(base) INTO v_bases, v_next FROM _par_bases;

  IF v_bases > 0 THEN
    INSERT INTO public.topshot_moment_subeditions (nft_id, base_external_id, subedition_id)
    SELECT cur.nft_id, cur.base, NULL::smallint
    FROM (
      SELECT DISTINCT w.moment_id AS nft_id, b.base
        FROM _par_bases b
        JOIN public.wallet_moments_cache w
          ON w.collection_id = v_ts AND w.edition_key = b.base
       WHERE w.moment_id ~ '^[0-9]+$'
      UNION
      SELECT DISTINCT s.nft_id, b.base
        FROM _par_bases b
        JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = b.base
        JOIN public.sales s ON s.collection_id = v_ts AND s.edition_id = e.id
       WHERE s.nft_id ~ '^[0-9]+$'
    ) cur
    WHERE NOT EXISTS (SELECT 1 FROM public.topshot_moment_subeditions t WHERE t.nft_id = cur.nft_id)
    LIMIT GREATEST(LEAST(p_max_rows, GREATEST(p_queue_cap, 0) - v_queue), 1)
    ON CONFLICT (nft_id) DO NOTHING;
    GET DIAGNOSTICS v_seeded = ROW_COUNT;
  END IF;

  UPDATE public.topshot_parallel_seed_state
     SET cursor_base = CASE WHEN v_bases > 0 THEN v_next ELSE '' END,
         cycles      = cycles + CASE WHEN v_bases > 0 THEN 0 ELSE 1 END,
         updated_at  = now()
   WHERE id = 1;

  RETURN jsonb_build_object('bases', v_bases, 'seeded', v_seeded, 'cursor', v_next, 'pending_before', v_queue);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.seed_topshot_parallel_base_targets(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_topshot_parallel_base_targets(integer, integer, integer) TO postgres, service_role, cron_heavy;
-- The 2-arg overload the previous migration created is replaced by this 3-arg one; drop it so the
-- cron command below binds unambiguously and no un-revoked overload lingers (the acl trap in
-- __tests__/migration-new-function-states-its-anon-exec-decision.test.ts).
DROP FUNCTION IF EXISTS public.seed_topshot_parallel_base_targets(integer, integer);

SELECT cron.unschedule('rpc-topshot-parallel-seed');
SELECT cron.schedule('rpc-topshot-parallel-seed', '31,57 * * * *', $$SELECT public.seed_topshot_parallel_base_targets(60, 4000, 10000)$$);
