-- audit_20261126_populate_wmc_image_skips_rows_another_writer_holds
--
-- Claude Code cloud, 2026-11-26 ~3:00 AM PT. populate_wmc_image's two NULL-only hot paths (editions-based collections,
-- and Pinnacle) now lock their batch with FOR UPDATE OF wmc SKIP LOCKED. Nothing else in the function changes.
--
-- WHY: Postgres logged 11 deadlocks in the 24 h to ~2:55 AM PT 11-26; 9 were populate_wmc_image (wmc-fmv-populate,
-- every ~5 min per collection, 273k Top Shot rows imaged in that window) against backfill_wmc_metadata_from_editions
-- (the wallet-search / wallet-refresh metadata fill) updating the same wallet_moments_cache rows in different order.
-- The METADATA fill was the victim 6 times, which leaves a user's freshly refreshed wallet without its metadata pass;
-- the image fill was the victim 4 times, and separately hit "lock timeout" 4 times in wmc-fmv-populate's extra.
-- With SKIP LOCKED the image fill never waits on a wmc row, so it can no longer be one side of a wait cycle, and a
-- row it skips is still image_url IS NULL and is taken on the next tick (the batch is LIMIT p_limit of the fillable
-- rows, so skipping does not starve the head).
-- Plan with the lock clause (EXPLAIN, live): Limit -> LockRows -> Nested Loop over idx_wmc_image_url_null and
-- editions_external_id_collection_id_key, the same access path as before.
--
-- Base: live prosrc md5 e04ece88356fb9dd566f0025a8b2b349 = the body of 20261110210433 (asserted below).
-- anon-exec: unchanged (populate_wmc_image) — CREATE OR REPLACE of an existing fn keeps its ACL.
--
-- REVERT: re-apply supabase/migrations/20261110210433_audit_20261110_populate_wmc_image_limits_after_the_edition_join.sql
-- (its guard expects md5 881aafff…, so run only its CREATE OR REPLACE statement), i.e. drop the two
-- "FOR UPDATE OF wmc SKIP LOCKED" lines.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.populate_wmc_image(uuid,boolean,integer)'::regprocedure) <> 'e04ece88356fb9dd566f0025a8b2b349' THEN
    RAISE EXCEPTION 'populate_wmc_image changed since it was read (expected md5 e04ece88...); re-derive before replacing';
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
        -- 2026-11-26: take only rows no other transaction holds; a skipped row is filled on a later tick.
        FOR UPDATE OF wmc SKIP LOCKED
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
        FOR UPDATE OF wmc SKIP LOCKED
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
