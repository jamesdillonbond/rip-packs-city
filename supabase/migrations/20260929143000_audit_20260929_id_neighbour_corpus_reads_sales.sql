-- 2026-09-29 (PT) — the id-neighbour corpus also reads every Top Shot moment id
-- a recorded SALE names.
--
-- WHY. name_pack_pulls_by_id_neighbours() (20260929130700) names a pull from
-- its nearest known ids. The corpus read wallet caches, moments, the ownership
-- walk and the edition map (2.48M ids) -- not `sales`, where 86 % of sampled
-- 2024 Top Shot sale ids are absent from it. With sales the corpus is 4.17M ids
-- (trial build 2026-09-29): precision on pulls we can name 5,086 / 5,115
-- (99.4 %), reach 85 % of them (was ~79 %), and 3,345 more of the 12,968 still
-- unnamed pulls become nameable (1,934 of Rigged's).
--
-- A nightly full scan of ~5.7M sales rows is the wrong cost, so:
--   topshot_sale_id_editions   one row per sold Top Shot moment id; edition
--                              NULL when its sales disagree (never used).
--   refresh_topshot_sale_id_editions(p_from, p_to)  folds the sales sold in
--                              [p_from, p_to) in (conflicts go NULL, for good).
--                              pg_cron rpc-topshot-sale-id-editions 11 10 * * *
--                              (3:11 AM PT) over the last 14 days -- before the
--                              corpus rebuild at 3:23; the backfill is one call
--                              per sales year, run by hand once (ledger).
--   refresh_topshot_moment_id_editions (guarded splice, base 2a04976c0f3573b14428189efe0caaf0):
--                              reads the table; an id marked conflicting drops.
-- anon-exec: refresh_topshot_sale_id_editions() — new; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: unchanged (refresh_topshot_moment_id_editions) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-29).
--
-- Revert: re-apply refresh_topshot_moment_id_editions from 20260929130700 and
--   repoint its pin; SELECT cron.unschedule('rpc-topshot-sale-id-editions');
--   DROP FUNCTION public.refresh_topshot_sale_id_editions(timestamptz, timestamptz);
--   DROP TABLE public.topshot_sale_id_editions; then SELECT public.refresh_topshot_moment_id_editions();

CREATE TABLE IF NOT EXISTS public.topshot_sale_id_editions (
  id                  bigint PRIMARY KEY,
  edition_external_id text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.topshot_sale_id_editions IS
  'Top Shot moment id -> edition external_id from recorded sales (public.sales). edition NULL = its sales disagree; never used. Written by refresh_topshot_sale_id_editions(); read by refresh_topshot_moment_id_editions().';
ALTER TABLE public.topshot_sale_id_editions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_sale_id_editions FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_topshot_sale_id_editions(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_read int := 0; v_written int := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'p_from < p_to required');
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_topshot_sale_id_editions')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  WITH src AS (
    SELECT s.nft_id::bigint AS id, e.external_id AS ext
      FROM public.sales s
      JOIN public.editions e ON e.id = s.edition_id AND e.collection_id = v_ts
     WHERE s.collection_id = v_ts
       AND s.sold_at >= p_from AND s.sold_at < p_to
       AND s.nft_id ~ '^[0-9]{1,15}$'
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ), g AS (
    SELECT id, CASE WHEN count(DISTINCT ext) = 1 THEN min(ext) END AS ext, count(*) AS n
      FROM src GROUP BY id
  ), up AS (
    INSERT INTO public.topshot_sale_id_editions AS t (id, edition_external_id, updated_at)
    SELECT id, ext, now() FROM g
    ON CONFLICT (id) DO UPDATE
      -- a disagreement, now or before, is final: NULL
      SET edition_external_id = CASE WHEN t.edition_external_id IS NOT DISTINCT FROM EXCLUDED.edition_external_id
                                     THEN t.edition_external_id END,
          updated_at = now()
      WHERE t.edition_external_id IS DISTINCT FROM EXCLUDED.edition_external_id
    RETURNING 1
  )
  SELECT (SELECT coalesce(sum(n), 0) FROM g), (SELECT count(*) FROM up) INTO v_read, v_written;

  PERFORM public.log_pipeline_run('topshot-sale-id-editions', v_started, v_read, v_written, 0, true, NULL,
    'nba_top_shot', p_from::text, p_to::text,
    jsonb_build_object('sales_read', v_read, 'ids_written', v_written));
  RETURN jsonb_build_object('ok', true, 'sales_read', v_read, 'ids_written', v_written);
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_topshot_sale_id_editions(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_sale_id_editions(timestamptz, timestamptz) TO postgres, service_role;

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.refresh_topshot_moment_id_editions()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '2a04976c0f3573b14428189efe0caaf0' AND v_md5 IS DISTINCT FROM 'ff1c66bd7f9a7d6c0e89359073c0facb' THEN
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

SELECT cron.schedule('rpc-topshot-sale-id-editions', '11 10 * * *',
  $$SELECT public.refresh_topshot_sale_id_editions(now() - interval '14 days', now() + interval '1 day');$$);
