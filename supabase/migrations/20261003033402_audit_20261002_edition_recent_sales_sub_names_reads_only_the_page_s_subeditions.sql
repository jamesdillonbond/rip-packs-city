-- 2026-10-02 (PT) — get_edition_recent_sales: sub_names reads only the
-- subedition ids on this page's sales, Top Shot editions only.
--
-- WHY. The edition page calls this on every render (810,101 calls since
-- 2026-08-12, 198 ms pooled mean, max at the 8 s statement_timeout). On the
-- busiest Top Shot edition (258:9304, 2026-10-02 ~8:45 PM PT) one first call read
-- 9,255 buffers / 66 ms for 30 rows: ~3.8k in the #142 serial-ceiling
-- subquery (bitmap scan of all 14,485 Top Shot editions on split_part — fixed
-- by the index in 20261003033052, 3,806 -> 5 buffers, function now 5,534 /
-- 21 ms) and ~2.1k in sub_names, a DISTINCT ON over every edition carrying a
-- subedition in EVERY collection, on every Top Shot call.
--
-- WHAT. sub_names keeps the same output for every page: restricted to the
-- subedition ids (> 0, the only ones the CASE reads) that this page's sales
-- carry, to Top Shot editions (the body never scoped it — latent: 0
-- subedition ids carry two names across collections today), and the name is
-- a tiebreak (DISTINCT ON had none; each Top Shot id has exactly 1 name today).
--
-- ⚠ COST: NEUTRAL, NOT A WIN. The ~2.1k-buffer figure above came from running
-- sub_names as a standalone query; inside the function it costs far less.
-- Measured steady state (21 calls minus 1, same session, index present):
-- old body 388 buffers / 2.1 ms per call, this body 440 / 1.7 ms. The real
-- saving is the index (20261003033052). This body ships for the scoping and
-- the deterministic name, not for speed.
--
-- EQUIVALENCE (measured): old vs this body as pg_temp, 120 editions (40
-- busiest Top Shot, 30 :: parallels, 30 random Top Shot, 20 All Day), 12,142
-- rows at limit 200; IS DISTINCT FROM = 0 at limit 30 and 200; 59 of the 120
-- render a named parallel, so the changed CTE is exercised. Control: the same
-- comparison returns 2 of 2 for limit 30 vs 29.
-- anon-exec: unchanged (get_edition_recent_sales) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
--
-- Revert: re-apply the body from
--   supabase/migrations/20260926042518_audit_20260925_edition_page_refuses_sales_whose_serial_cannot_exist.sql
-- (its get_edition_recent_sales block) and repoint the pin.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_edition_recent_sales(uuid,text,integer,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'fe2fb4cd465c13647817ae8865349c59' THEN
    RAISE EXCEPTION 'get_edition_recent_sales changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_edition_recent_sales(p_collection_id uuid, p_route_slug text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_topshot_uuid  CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_safe_limit    int  := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 200);
  v_safe_offset   int  := GREATEST(COALESCE(p_offset, 0), 0);
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    WITH recent AS (
      SELECT
        ps.serial_number,
        ps.sale_price_usd                  AS price_usd,
        NULL::text                         AS marketplace,
        ps.source                          AS source,
        ps.buyer_address,
        ps.seller_address,
        ps.nft_id,
        NULL::text                         AS transaction_hash,
        ps.sold_at
      FROM pinnacle_sales ps
      WHERE ps.edition_id = p_route_slug
      ORDER BY ps.sold_at DESC
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(recent.*) ORDER BY recent.sold_at DESC), '[]'::jsonb)
    INTO result
    FROM recent;
  ELSE
    WITH ed AS (
      SELECT id, external_id, subedition_name, circulation_count FROM editions
      WHERE collection_id = p_collection_id
        AND (external_id = p_route_slug OR id::text = p_route_slug)
      LIMIT 1
    ),
    recent AS (
      SELECT
        sa.serial_number,
        sa.price_usd,
        sa.marketplace::text                     AS marketplace,
        sa.source                                AS source,
        sa.buyer_address::text                   AS buyer_address,
        sa.seller_address::text                  AS seller_address,
        sa.nft_id::text                          AS nft_id,
        sa.transaction_hash::text                AS transaction_hash,
        sa.sold_at,
        ed.external_id                           AS ed_external_id,
        ed.subedition_name                       AS ed_subedition_name
      FROM ed
      JOIN sales sa ON sa.edition_id = ed.id
      -- 2026-09-25 (#142): refuse a sale whose serial cannot exist in this
      -- edition. The ceiling is base + parallels (serials are shared across a
      -- (set, play) and its subeditions — 20260922200554), which equals the
      -- chain's getNumMomentsInEdition. Subtractive and NULL-escaping; the
      -- total is an InitPlan, reached only for a serial above the row's own
      -- circulation, so a normal page load never pays for it.
      WHERE sa.serial_number IS NULL
         OR ed.circulation_count IS NULL OR ed.circulation_count <= 0
         OR sa.serial_number <= ed.circulation_count
         OR sa.serial_number <= (
              SELECT sum(e2.circulation_count) FROM editions e2
              WHERE e2.collection_id = p_collection_id
                AND e2.circulation_count > 0
                AND split_part(e2.external_id, '::', 1) = split_part((SELECT external_id FROM ed), '::', 1))
      ORDER BY sa.sold_at DESC
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    -- subedition_id -> printing name, from the cataloged :: editions.
    -- 2026-10-02: only the subedition ids this page's sales carry, Top Shot
    -- editions only, name as tiebreak (was: every edition with a subedition in
    -- every collection, ~2.1k buffers per call, arbitrary name on a tie).
    sub_names AS (
      SELECT DISTINCT ON (e.subedition_id) e.subedition_id, e.subedition_name
      FROM editions e
      WHERE p_collection_id = v_topshot_uuid
        AND e.collection_id = v_topshot_uuid
        AND e.subedition_id IN (
              SELECT t.subedition_id
              FROM recent r2
              JOIN topshot_moment_subeditions t ON t.nft_id = r2.nft_id
              WHERE t.subedition_id > 0)
        AND e.subedition_name IS NOT NULL
      ORDER BY e.subedition_id, e.subedition_name
    ),
    enriched AS (
      SELECT
        r.serial_number, r.price_usd, r.marketplace, r.source,
        r.buyer_address, r.seller_address, r.nft_id, r.transaction_hash, r.sold_at,
        CASE WHEN p_collection_id = v_topshot_uuid THEN
          COALESCE(
            CASE WHEN tms.subedition_id > 0
                   THEN COALESCE(sn.subedition_name, 'Parallel #' || tms.subedition_id)
                 WHEN tms.subedition_id = 0 THEN 'Standard'
            END,
            NULLIF(r.ed_subedition_name, ''),
            CASE WHEN r.ed_external_id ~ '^[0-9]+:[0-9]+$' THEN 'Standard' END
          )
        END AS parallel
      FROM recent r
      LEFT JOIN topshot_moment_subeditions tms
        ON p_collection_id = v_topshot_uuid AND tms.nft_id = r.nft_id
      LEFT JOIN sub_names sn ON sn.subedition_id = tms.subedition_id
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(enriched.*) ORDER BY enriched.sold_at DESC), '[]'::jsonb)
    INTO result
    FROM enriched;
  END IF;

  RETURN result;
END;
$function$;