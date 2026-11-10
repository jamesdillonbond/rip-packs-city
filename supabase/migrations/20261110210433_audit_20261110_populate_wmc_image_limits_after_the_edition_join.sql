-- audit_20261110_populate_wmc_image_limits_after_the_edition_join
--
-- Claude Code cloud, 2026-11-10 ~1:04 PM PT (DB clock). One change to populate_wmc_image's NULL-only hot path for
-- editions-based collections: the LIMIT is applied AFTER the join to editions (thumbnail LIKE 'http%'), not before.
--
-- WHY: the old path took the first p_limit (50,000) image_url-NULL wallet rows in idx_wmc_image_url_null order and
-- only then joined editions. 93,965 Candy rows had no image; 87.7k of them sit on editions with no http thumbnail
-- (name-only / IPFS), so every tick re-read the same unfillable head (pgss 2-h delta: 175 calls, 581k blocks read)
-- and the 6,252 FILLABLE rows (2,326 wallets, 185 editions, all older than 24 h, oldest 11-08 4:44 PM PT) were never
-- reached — cards rendered without images while the lane reported ok with 0 written. The CLAUDE.md "a leg's ORDER BY
-- decides whether it progresses at all" class. New hot path measured: all 6,252 fillable rows in 15k buffers / 118 ms
-- (hash join over the partial index + editions).
--
-- Base: live prosrc md5 881aafff0286d28dee19ea47ecc28057 (asserted below; no earlier migration file defines this
-- function — the live body was the only source). Force path and Pinnacle branch unchanged (Pinnacle: 0 NULL rows).
--
-- anon-exec: unchanged (populate_wmc_image) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false, service_role=true.
--
-- REVERT: CREATE OR REPLACE the function below with its editions NULL-only branch (the ELSE under "HOT PATH")
-- restored to the previous text, verbatim:
--       WITH targets AS (
--         SELECT wmc.id, wmc.collection_id, wmc.edition_key
--         FROM public.wallet_moments_cache wmc
--         WHERE wmc.image_url IS NULL
--           AND wmc.collection_id <> v_pinnacle
--           AND wmc.edition_key IS NOT NULL
--           AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
--         LIMIT p_limit
--       ),
--       matched AS (
--         SELECT t.id, e.thumbnail_url
--         FROM targets t
--         JOIN public.editions e
--           ON e.collection_id = t.collection_id AND e.external_id = t.edition_key
--         WHERE e.thumbnail_url LIKE 'http%'
--       ),
--       upd AS ( ...unchanged... )
-- (everything else in the function is identical to the body below).

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.populate_wmc_image(uuid,boolean,integer)'::regprocedure) <> '881aafff0286d28dee19ea47ecc28057' THEN
    RAISE EXCEPTION 'populate_wmc_image changed since it was read (expected md5 881aafff...); re-derive before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.populate_wmc_image(p_collection_id uuid DEFAULT NULL::uuid, p_force boolean DEFAULT false, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pinnacle uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_updated integer := 0;
  v_n integer;
BEGIN
  -- Editions-based collections (TS / AllDay / Golazos / UFC).
  IF p_collection_id IS NULL OR p_collection_id <> v_pinnacle THEN
    IF p_force THEN
      WITH targets AS (
        SELECT wmc.id, wmc.collection_id, wmc.edition_key
        FROM public.wallet_moments_cache wmc
        WHERE wmc.collection_id <> v_pinnacle
          AND wmc.edition_key IS NOT NULL
          AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
        LIMIT p_limit
      ),
      matched AS (
        SELECT t.id, e.thumbnail_url
        FROM targets t
        JOIN public.editions e
          ON e.collection_id = t.collection_id AND e.external_id = t.edition_key
        WHERE e.thumbnail_url LIKE 'http%'
      ),
      upd AS (
        UPDATE public.wallet_moments_cache wmc
        SET image_url = m.thumbnail_url
        FROM matched m
        WHERE wmc.id = m.id AND wmc.image_url IS DISTINCT FROM m.thumbnail_url
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM upd;
    ELSE
      -- HOT PATH: predicate matches idx_wmc_image_url_null exactly.
      -- 2026-11-10: the LIMIT is taken AFTER the edition join, so a batch is drawn only from rows that CAN be
      -- filled. Taken before it, the first p_limit NULL rows in index order were re-read every tick and most of
      -- them can never be filled (93,965 Candy rows with no image, 87.7k on editions with no http thumbnail), so
      -- 6,252 fillable Candy rows in 2,326 wallets sat unfilled since 11-08 while this ran every ~40 s.
      WITH matched AS (
        SELECT wmc.id, e.thumbnail_url
        FROM public.wallet_moments_cache wmc
        JOIN public.editions e
          ON e.collection_id = wmc.collection_id AND e.external_id = wmc.edition_key
        WHERE wmc.image_url IS NULL
          AND wmc.collection_id <> v_pinnacle
          AND wmc.edition_key IS NOT NULL
          AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
          AND e.thumbnail_url LIKE 'http%'
        LIMIT p_limit
      ),
      upd AS (
        UPDATE public.wallet_moments_cache wmc
        SET image_url = m.thumbnail_url
        FROM matched m
        WHERE wmc.id = m.id AND wmc.image_url IS DISTINCT FROM m.thumbnail_url
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM upd;
    END IF;
    v_updated := v_updated + COALESCE(v_n, 0);
  END IF;

  -- Pinnacle: render_id-keyed pinnacle_catalog source; thumbnail_url is the
  -- gate-free proxy path (/api/public/pinnacle-image/<render_id>), NOT http,
  -- so no LIKE filter. Same p_force split as above.
  IF p_collection_id IS NULL OR p_collection_id = v_pinnacle THEN
    IF p_force THEN
      WITH targets AS (
        SELECT wmc.id, wmc.render_id
        FROM public.wallet_moments_cache wmc
        WHERE wmc.collection_id = v_pinnacle
          AND wmc.render_id IS NOT NULL
        LIMIT p_limit
      ),
      matched AS (
        SELECT t.id, c.thumbnail_url
        FROM targets t
        JOIN public.pinnacle_catalog c ON c.render_id = t.render_id
        WHERE c.thumbnail_url IS NOT NULL
      ),
      upd AS (
        UPDATE public.wallet_moments_cache wmc
        SET image_url = m.thumbnail_url
        FROM matched m
        WHERE wmc.id = m.id AND wmc.image_url IS DISTINCT FROM m.thumbnail_url
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM upd;
    ELSE
      -- HOT PATH: image_url IS NULL first -> partial index.
      WITH targets AS (
        SELECT wmc.id, wmc.render_id
        FROM public.wallet_moments_cache wmc
        WHERE wmc.image_url IS NULL
          AND wmc.collection_id = v_pinnacle
          AND wmc.render_id IS NOT NULL
        LIMIT p_limit
      ),
      matched AS (
        SELECT t.id, c.thumbnail_url
        FROM targets t
        JOIN public.pinnacle_catalog c ON c.render_id = t.render_id
        WHERE c.thumbnail_url IS NOT NULL
      ),
      upd AS (
        UPDATE public.wallet_moments_cache wmc
        SET image_url = m.thumbnail_url
        FROM matched m
        WHERE wmc.id = m.id AND wmc.image_url IS DISTINCT FROM m.thumbnail_url
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM upd;
    END IF;
    v_updated := v_updated + COALESCE(v_n, 0);
  END IF;

  RETURN v_updated;
END;
$function$;
