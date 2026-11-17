-- 2026-09-29 (PT) — a Top Shot pull no record names is named by its id
-- NEIGHBOURS, labelled as an inference.
--
-- WHY (Trevor: "check out Rigged ... he's opened the most packs"). Rigged
-- (0xf77bf547fccf6656) has opened 10,934 Top Shot packs; 5,731 carry no value
-- because 12,898 of their pulls have no edition. Those moments have left every
-- wallet we walk and appear in no sale, ownership or edition-map row (burned,
-- most likely), and every outside source is closed: Dapper's Top Shot index
-- answers 0 even for the 38k moments he holds, nbatopshot.com is behind a
-- Cloudflare challenge, public-api answers 530, and Flow mint events are below
-- the spork floor. Estate-wide 24,527 Top Shot pulls are unnamed.
--
-- Top Shot mints moments in BATCHES: one edition, consecutive ids. So a pull
-- whose nearest known id on each side carries the SAME edition, both within
-- 50 ids, is that edition. Validated 2026-09-29 against 5,000 + 8,000 pulls
-- we CAN name (the corpus below never contains pack_open_pulls, so the test is
-- independent): right on 3,167 of 3,189 (99.3 %); by open year 2024 706/716,
-- 2025 945/953, 2026 3,330/3,357. Past 50 ids it falls to 81 %, and neighbours
-- that disagree are never used. It reaches ~10,200 of the 24,527 (4,523 of
-- Rigged's).
--
-- WHAT.
--   topshot_moment_id_editions   Top Shot moment id -> edition external_id,
--                                from wallet_moments_cache, moments,
--                                topshot_ownership and nft_edition_map; an id
--                                two sources disagree on is left out.
--   refresh_topshot_moment_id_editions()  daily diff-rebuild (insert new,
--                                update changed, delete gone), pg_cron
--                                rpc-topshot-moment-id-editions 23 10 * * *
--                                (3:23 AM PT).
--   pack_open_pull_values.n_inferred  how many of a pack's pulls are named by
--                                inference (0 = every name is a record).
--   name_pack_pulls_by_id_neighbours()  names unnamed Top Shot pulls
--                                (resolved_via = 'id_neighbours'), queues their
--                                packs for repricing, keeps n_inferred; pg_cron
--                                rpc-pack-pulls-id-neighbours 29 */3 * * *.
-- A pull a record names later is NOT overwritten by this lane (it only touches
-- edition_id IS NULL); an inferred name is never fed back into the corpus.
-- anon-exec: refresh_topshot_moment_id_editions() — new; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: name_pack_pulls_by_id_neighbours() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-topshot-moment-id-editions');
--   SELECT cron.unschedule('rpc-pack-pulls-id-neighbours');
--   UPDATE public.pack_open_pulls SET edition_id = NULL, resolved_via = NULL, resolved_at = NULL
--    WHERE resolved_via = 'id_neighbours';
--   UPDATE public.pack_open_pull_values SET priced_at = '-infinity' WHERE n_inferred > 0;
--   ALTER TABLE public.pack_open_pull_values DROP COLUMN n_inferred;
--   DROP FUNCTION public.name_pack_pulls_by_id_neighbours(), public.refresh_topshot_moment_id_editions();
--   DROP TABLE public.topshot_moment_id_editions;

CREATE TABLE IF NOT EXISTS public.topshot_moment_id_editions (
  id                  bigint PRIMARY KEY,
  edition_external_id text NOT NULL,
  refreshed_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.topshot_moment_id_editions IS
  'Top Shot moment id -> edition external_id from wallet_moments_cache, moments, topshot_ownership and nft_edition_map (ids two sources disagree on are left out). The id-ordered corpus name_pack_pulls_by_id_neighbours() reads. Never contains an inferred name. Written by refresh_topshot_moment_id_editions().';
ALTER TABLE public.topshot_moment_id_editions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_moment_id_editions FROM anon, authenticated;

ALTER TABLE public.pack_open_pull_values ADD COLUMN IF NOT EXISTS n_inferred int NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.pack_open_pull_values.n_inferred IS
  'How many of this pack''s pulls are named by inference (pack_open_pulls.resolved_via = id_neighbours), kept by name_pack_pulls_by_id_neighbours(). 0 = every name comes from a record.';


-- ── refresh_topshot_moment_id_editions ──────────────────────────────────────
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
  ) u
  GROUP BY u.id
  HAVING count(DISTINCT u.ext) = 1;
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


-- ── name_pack_pulls_by_id_neighbours ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.name_pack_pulls_by_id_neighbours()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cand int := 0; v_named int := 0; v_packs int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('name_pack_pulls_by_id_neighbours')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  SELECT count(*) INTO v_cand FROM public.pack_open_pulls
   WHERE collection_id = v_ts AND edition_id IS NULL AND nft_id ~ '^[0-9]{1,15}$';

  WITH cand AS MATERIALIZED (
    SELECT p.pack_nft_id, p.nft_id, p.nft_id::bigint AS id
    FROM public.pack_open_pulls p
    WHERE p.collection_id = v_ts AND p.edition_id IS NULL AND p.nft_id ~ '^[0-9]{1,15}$'
  ), pred AS (
    SELECT c.*, lo.id AS lo_id, lo.ext AS lo_ext, hi.id AS hi_id, hi.ext AS hi_ext
    FROM cand c
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
       WHERE t.id < c.id ORDER BY t.id DESC LIMIT 1
    ) lo ON true
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
       WHERE t.id > c.id ORDER BY t.id ASC LIMIT 1
    ) hi ON true
  ), named AS (
    -- both neighbours the SAME edition, each within 50 ids (99.3 % measured);
    -- the edition must exist in our catalogue
    SELECT p.pack_nft_id, p.nft_id, e.id AS edition_id
    FROM pred p
    JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = p.lo_ext
    WHERE p.lo_ext = p.hi_ext
      AND p.id - p.lo_id <= 50
      AND p.hi_id - p.id <= 50
  ), upd AS (
    UPDATE public.pack_open_pulls o
       SET edition_id = n.edition_id, resolved_via = 'id_neighbours', resolved_at = now()
      FROM named n
     WHERE o.collection_id = v_ts AND o.pack_nft_id = n.pack_nft_id AND o.nft_id = n.nft_id
       AND o.edition_id IS NULL
    RETURNING o.pack_nft_id
  )
  SELECT count(*) INTO v_named FROM upd;

  -- every pack carrying an inferred name: keep n_inferred exact and queue a
  -- reprice where it changed
  WITH cnt AS (
    SELECT o.pack_nft_id, count(*) AS n
      FROM public.pack_open_pulls o
     WHERE o.collection_id = v_ts AND o.resolved_via = 'id_neighbours'
     GROUP BY o.pack_nft_id
  ), upd AS (
    UPDATE public.pack_open_pull_values v
       SET n_inferred = coalesce(c.n, 0), priced_at = '-infinity'
      FROM (SELECT v2.pack_nft_id, cnt.n
              FROM public.pack_open_pull_values v2
              LEFT JOIN cnt ON cnt.pack_nft_id = v2.pack_nft_id
             WHERE v2.collection_id = v_ts
               AND v2.n_inferred IS DISTINCT FROM coalesce(cnt.n, 0)) c
     WHERE v.collection_id = v_ts AND v.pack_nft_id = c.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_packs FROM upd;

  PERFORM public.log_pipeline_run('pack-pulls-id-neighbours', v_started, v_cand, v_named, v_cand - v_named, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs));
  RETURN jsonb_build_object('ok', true, 'unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs);
END;
$function$;

-- Service-side only: pg_cron (postgres).
REVOKE ALL ON FUNCTION public.refresh_topshot_moment_id_editions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.name_pack_pulls_by_id_neighbours() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_moment_id_editions() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.name_pack_pulls_by_id_neighbours() TO postgres, service_role;

SELECT cron.schedule('rpc-topshot-moment-id-editions', '23 10 * * *', 'SELECT public.refresh_topshot_moment_id_editions();');
SELECT cron.schedule('rpc-pack-pulls-id-neighbours', '29 */3 * * *', 'SELECT public.name_pack_pulls_by_id_neighbours();');
