-- 2026-09-29 (PT) — the id-neighbour corpus also reads Standard Atlas market events.
--
-- WHY. After sales, the corpus (4.17M ids) still left 9,670 Top Shot pulls
-- unnamed (6,041 of Rigged's). topshot_atlas_market_events' Standard events
-- name 655,881 moment ids; 210,731 are not in the corpus, and on the ~445k that
-- are, only 812 (0.18 %) disagree. Trial: +619 pulls nameable (410 Rigged's).
-- The pull lane already trusts Standard Atlas events as a record (99.9 %,
-- 2026-09-26); parallel events stay excluded (~92 %).
--
-- WHAT. Guarded splice of refresh_topshot_moment_id_editions (base ff1c66bd7f9a7d6c0e89359073c0facb
-- = 20260929143000): one more UNION arm. An id Atlas and another source
-- disagree on is dropped by the existing count(DISTINCT) = 1 rule.
-- anon-exec: unchanged (refresh_topshot_moment_id_editions) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-29).
--
-- Revert: re-apply refresh_topshot_moment_id_editions from
--   supabase/migrations/20260929143000_audit_20260929_id_neighbour_corpus_reads_sales.sql,
--   repoint its pin, then SELECT public.refresh_topshot_moment_id_editions(), public.name_pack_pulls_by_id_neighbours();

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.refresh_topshot_moment_id_editions()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'ff1c66bd7f9a7d6c0e89359073c0facb' AND v_md5 IS DISTINCT FROM 'a8663059edf1b8d3e7a6a80718578fb8' THEN
    RAISE EXCEPTION 'refresh_topshot_moment_id_editions changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.refresh_topshot_moment_id_editions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_built int := 0; v_ins int := 0; v_upd int := 0; v_del int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_topshot_moment_id_editions')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  DROP TABLE IF EXISTS _tmie;  -- a second call in the same transaction
  CREATE TEMP TABLE _tmie ON COMMIT DROP AS
  SELECT u.id, min(u.ext) AS ext
  FROM (
    SELECT w.moment_id::bigint AS id, w.edition_key AS ext
      FROM public.wallet_moments_cache w
     WHERE w.collection_id = v_ts AND w.moment_id ~ '^[0-9]{1,15}$'
       AND w.edition_key ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    SELECT m.nft_id::bigint, e.external_id
      FROM public.moments m JOIN public.editions e ON e.id = m.edition_id AND e.collection_id = v_ts
     WHERE m.collection_id = v_ts AND m.nft_id ~ '^[0-9]{1,15}$'
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    SELECT t.nft_id::bigint, t.edition_external_id
      FROM public.topshot_ownership t
     WHERE t.nft_id ~ '^[0-9]{1,15}$' AND t.edition_external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    SELECT n.nft_id::bigint, n.edition_external_id
      FROM public.nft_edition_map n
     WHERE n.collection_id = v_ts AND n.nft_id ~ '^[0-9]{1,15}$'
       AND n.edition_external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    UNION ALL
    -- 2026-09-29: every Top Shot moment id a recorded SALE names (4.17M ids
    -- with it, from 2.48M), kept by refresh_topshot_sale_id_editions(); an id
    -- whose sales disagree carries '!' and so drops out below
    SELECT s.id, coalesce(s.edition_external_id, '!')
      FROM public.topshot_sale_id_editions s
    UNION ALL
    -- 2026-09-29: a Standard Atlas market event names its moment id (matched a
    -- record on 99.9 % when checked 09-26; 812 of ~445k overlapping ids
    -- disagree today, and the count(DISTINCT) rule drops those). Parallel
    -- events are NOT used: their label survives the edition map only ~92 %.
    SELECT a.nft_id::bigint, e.external_id
      FROM public.topshot_atlas_market_events a
      JOIN public.topshot_atlas_edition_map am ON am.atlas_edition_id = a.atlas_edition_id AND am.parallel = 'Standard'
      JOIN public.editions e ON e.id = am.rpc_edition_id AND e.collection_id = v_ts
     WHERE a.product = 'nba' AND a.parallel = 'Standard'
       AND a.nft_id::text ~ '^[0-9]{1,15}$'
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ) u
  GROUP BY u.id
  HAVING count(DISTINCT u.ext) = 1 AND min(u.ext) <> '!';
  GET DIAGNOSTICS v_built = ROW_COUNT;

  -- A build that came back empty is a failed read, never "no moments": keep
  -- the table as it is.
  IF v_built = 0 THEN
    PERFORM public.log_pipeline_run('topshot-moment-id-editions', v_started, 0, 0, 0, false,
      'build returned 0 ids -- table left unchanged', 'nba_top_shot', NULL, NULL, '{}'::jsonb);
    RETURN jsonb_build_object('ok', false, 'reason', 'build returned 0 ids');
  END IF;

  INSERT INTO public.topshot_moment_id_editions (id, edition_external_id, refreshed_at)
  SELECT b.id, b.ext, now() FROM _tmie b
  ON CONFLICT (id) DO UPDATE SET edition_external_id = EXCLUDED.edition_external_id, refreshed_at = now()
    WHERE topshot_moment_id_editions.edition_external_id IS DISTINCT FROM EXCLUDED.edition_external_id;
  GET DIAGNOSTICS v_ins = ROW_COUNT;  -- new + changed

  -- written first; now delete only ids the build no longer names
  DELETE FROM public.topshot_moment_id_editions t
   WHERE NOT EXISTS (SELECT 1 FROM _tmie b WHERE b.id = t.id);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  PERFORM public.log_pipeline_run('topshot-moment-id-editions', v_started, v_built, v_ins, 0, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('built', v_built, 'inserted_or_changed', v_ins, 'deleted', v_del));
  RETURN jsonb_build_object('ok', true, 'built', v_built, 'inserted_or_changed', v_ins, 'deleted', v_del);
END;
$function$;
