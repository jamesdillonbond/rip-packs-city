-- audit_20261126_populate_wmc_image_pinnacle_locks_only_fillable_rows
--
-- Claude Code cloud, 2026-11-26 ~8:40 AM PT. Follow-up to 20261126105906 (SKIP LOCKED on both NULL-only hot paths).
-- That migration left the PINNACLE hot path locking its batch BEFORE the pinnacle_catalog join: `targets` took
-- p_limit image_url-NULL Pinnacle rows FOR UPDATE SKIP LOCKED and only then dropped the ones with no catalog
-- thumbnail. That is the shape database.md forbids ("LOCK WHAT YOU WILL WRITE, NOT WHAT YOU READ", 2026-11-11):
-- it holds rows it will never update, and it re-reads the same unfillable head every tick (the 11-10 editions-path
-- defect). Now the join and the thumbnail filter come first, then LIMIT, then the lock, exactly as the editions path.
-- Live at apply: 0 Pinnacle rows with image_url NULL (0 fillable), so no behaviour changes today.
-- pinnacle_catalog.render_id is its primary key, so the join cannot duplicate a wmc row.
--
-- Base: live prosrc md5 25a8d5755b1aa3a643abdce010d7a5cf = the body of 20261126105906 (asserted below).
-- anon-exec: unchanged (populate_wmc_image) — CREATE OR REPLACE of an existing fn keeps its ACL.
--
-- REVERT: run only the CREATE OR REPLACE statement of 20261126105906_audit_20261126_populate_wmc_image_skips_rows_another_writer_holds.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.populate_wmc_image(uuid,boolean,integer)'::regprocedure) <> '25a8d5755b1aa3a643abdce010d7a5cf' THEN
    RAISE EXCEPTION 'populate_wmc_image changed since it was read (expected md5 25a8d575...); re-derive before replacing';
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
      -- 2026-11-26: join BEFORE the LIMIT and the lock, as the editions path does, so a batch is drawn only from
      -- rows that CAN be filled and only those rows are locked (pinnacle_catalog.render_id is its primary key, so
      -- the join cannot duplicate a row).
      WITH matched AS (
        SELECT wmc.id, c.thumbnail_url
        FROM public.wallet_moments_cache wmc
        JOIN public.pinnacle_catalog c ON c.render_id = wmc.render_id
        WHERE wmc.image_url IS NULL
          AND wmc.collection_id = v_pinnacle
          AND wmc.render_id IS NOT NULL
          AND c.thumbnail_url IS NOT NULL
        LIMIT p_limit
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

  RETURN v_updated;
END;
$function$;
