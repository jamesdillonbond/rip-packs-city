-- audit_20261017_parallel_seeder_cursor_never_passes_an_unseeded_base
-- 2026-10-17 (Claude Code, Windows box; Trevor: "Make your own decisions on this and take care of it").
--
-- FOUND verifying D25's other direction ON-CHAIN: a 1,197-row random sample of Top Shot wmc rows from the
-- 2026-05-06..08 seeding era had 9 (0.75 %) PARALLEL moments filed under their BASE edition (e.g. a
-- `90:3564::3` moment keyed `90:3564`). They are invisible to D25's serial>circulation detector (a base run
-- is larger than any parallel serial), and they price a parallel at its base FMV. The lane built for them
-- exists and its downstream works (only 72 resolved parallels are still base-keyed), but its SEEDER skips:
--
--   seed_topshot_parallel_base_targets takes the next p_bases (60) bases, inserts at most
--   LEAST(p_max_rows, p_queue_cap - queue) of their moments in NO particular order, then sets the cursor
--   to the LAST of the 60 bases regardless. Every moment past the row limit is skipped until the next full
--   cycle (~20 h), and which ones is arbitrary. Measured: after 3 full cycles over all 2,298 bases with
--   parallels, 66,001 of 349,957 base-keyed wmc rows had never been queued.
--
-- The 20260904133105 header states the intended property ("the cursor does not advance on a yielded tick
-- so no base is skipped"); it covered the queue-full yield and missed truncation by the row LIMIT.
--
-- FIX: candidates are inserted ORDER BY (base, nft_id), the INSERT RETURNs what landed, and when the
-- limit is reached the cursor stops at the base BEFORE the last one seeded (that one is partial), so the
-- next tick resumes inside it; NOT EXISTS skips what is already queued, so a base larger than the limit
-- still advances tick by tick. A window that fits under the limit advances exactly as before. Return gains
-- `truncated`. Signature, defaults, SECURITY DEFINER, search_path and statement_timeout are unchanged.
-- anon-exec: no — writer; the REVOKE/GRANT below is re-stated (CREATE OR REPLACE keeps the acl).
-- REVERT: re-apply the body in 20260904133105 (same signature; this file changes the body only).

CREATE OR REPLACE FUNCTION public.seed_topshot_parallel_base_targets(p_bases integer DEFAULT 60, p_max_rows integer DEFAULT 4000, p_queue_cap integer DEFAULT 10000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cursor text;
  v_next   text;
  v_last   text;
  v_bases  integer := 0;
  v_seeded integer := 0;
  v_limit  integer;
  v_truncated boolean := false;
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
    v_limit := GREATEST(LEAST(p_max_rows, GREATEST(p_queue_cap, 0) - v_queue), 1);
    WITH ins AS (
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
      ORDER BY cur.base, cur.nft_id
      LIMIT v_limit
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING base_external_id
    )
    SELECT count(*)::int, max(base_external_id) INTO v_seeded, v_last FROM ins;

    -- The limit cut the window: every base before v_last is fully queued, v_last is partial. Park the
    -- cursor just before v_last so the next tick resumes inside it (NOT EXISTS skips what is queued).
    IF v_seeded >= v_limit THEN
      v_truncated := true;
      SELECT max(base) INTO v_next FROM _par_bases WHERE base < v_last;
      v_next := COALESCE(v_next, v_cursor);
    END IF;
  END IF;

  UPDATE public.topshot_parallel_seed_state
     SET cursor_base = CASE WHEN v_bases > 0 THEN v_next ELSE '' END,
         cycles      = cycles + CASE WHEN v_bases > 0 THEN 0 ELSE 1 END,
         updated_at  = now()
   WHERE id = 1;

  RETURN jsonb_build_object('bases', v_bases, 'seeded', v_seeded, 'cursor', v_next,
                            'pending_before', v_queue, 'truncated', v_truncated);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.seed_topshot_parallel_base_targets(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_topshot_parallel_base_targets(integer, integer, integer) TO postgres, service_role, cron_heavy;
