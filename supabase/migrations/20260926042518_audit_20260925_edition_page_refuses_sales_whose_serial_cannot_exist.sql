-- 2026-09-25 (PT) — #142: the edition page stops showing sales that cannot
-- belong to the edition.
--
-- WHY. 1,390 Top Shot sales (99 in the last year) on 41 editions and 28 All
-- Day sales on 26 carry a serial above the edition's TOTAL printing (base +
-- parallels, the ceiling 20260922200554 established). Settled on chain
-- 2026-09-25 ~9:20 PM PT: TopShot.getNumMomentsInEdition for all 42 affected
-- Top Shot (set, play) pairs — 37 equal the catalog exactly, so their
-- over-ceiling serials are impossible for ANY printing, i.e. misattributed
-- sales (e.g. Giannis Cosmic LEGENDARY 8:62: chain 49 minted, yet "sales" at
-- #107 / #272 / #355 for $1-$2). The live FMV route already drops them; the
-- edition page's recent-sales table and price-history chart did not, so a
-- 49-print Legendary showed "#355 sold $1" and a chart median of ~$2.
--
-- WHAT. get_edition_recent_sales and get_edition_sale_history refuse a sale
-- whose serial exceeds max(edition circulation, base+parallels total).
-- Subtractive only, NULL-escaping (no serial / no circulation keeps the row),
-- Pinnacle arms untouched. The sales rows are NOT deleted — their true
-- edition is unknown (the moments have moved wallets), so they stay for a
-- later re-key. Bodies are the live prosrc (md5-verified) plus the filter.
--
-- Revert: re-apply the previous bodies (the same functions without the
-- `-- 2026-09-25 (#142)` WHERE clauses).

-- anon-exec: intentional — ACL unchanged by CREATE OR REPLACE (service_role only) (get_edition_recent_sales, get_edition_sale_history)

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
    -- subedition_id -> printing name, from the cataloged :: editions (one scan).
    sub_names AS (
      SELECT DISTINCT ON (subedition_id) subedition_id, subedition_name
      FROM editions
      WHERE p_collection_id = v_topshot_uuid
        AND subedition_id IS NOT NULL AND subedition_name IS NOT NULL
      ORDER BY subedition_id
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

CREATE OR REPLACE FUNCTION public.get_edition_sale_history(p_collection_id uuid, p_route_slug text, p_days integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_all           boolean := (p_days IS NULL OR p_days <= 0);
  v_days          int := LEAST(GREATEST(COALESCE(p_days, 0), 0), 4000);
  v_cutoff        timestamptz := CASE WHEN v_all THEN '-infinity'::timestamptz
                                      ELSE now() - (v_days || ' days')::interval END;
  v_grain         text := CASE
                            WHEN NOT v_all AND v_days <= 120 THEN 'day'
                            WHEN NOT v_all AND v_days <= 800 THEN 'week'
                            ELSE 'month'
                          END;
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    WITH r AS (
      SELECT pc.render_id
      FROM pinnacle_catalog pc
      WHERE pc.render_id = p_route_slug
         OR pc.edition_id = p_route_slug
      ORDER BY (pc.render_id = p_route_slug) DESC,
               pc.fmv_sales_count_30d DESC NULLS LAST,
               pc.total_minted ASC NULLS LAST
      LIMIT 1
    ),
    bucketed AS (
      SELECT
        date_trunc(v_grain, ps.sold_at)::date                                   AS bucket,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.sale_price_usd)::numeric AS median_usd,
        min(ps.sale_price_usd)                                                  AS low_usd,
        max(ps.sale_price_usd)                                                  AS high_usd,
        count(*)::int                                                           AS sales_count,
        v_grain                                                                 AS grain
      FROM r
      JOIN pinnacle_sales ps
        ON ps.render_id = r.render_id
      WHERE ps.sold_at >= v_cutoff
        AND ps.sale_price_usd IS NOT NULL
        AND ps.sale_price_usd > 0
      GROUP BY 1
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(bucketed.*) ORDER BY bucketed.bucket), '[]'::jsonb)
    INTO result
    FROM bucketed;
  ELSE
    WITH ed AS (
      SELECT id, external_id, circulation_count FROM editions
      WHERE collection_id = p_collection_id
        AND (external_id = p_route_slug OR id::text = p_route_slug)
      LIMIT 1
    ),
    bucketed AS (
      SELECT
        date_trunc(v_grain, s.sold_at)::date                                AS bucket,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)::numeric   AS median_usd,
        min(s.price_usd)                                                    AS low_usd,
        max(s.price_usd)                                                    AS high_usd,
        count(*)::int                                                       AS sales_count,
        v_grain                                                             AS grain
      FROM ed
      JOIN sales s ON s.edition_id = ed.id
      WHERE s.sold_at >= v_cutoff
        AND s.price_usd IS NOT NULL
        AND s.price_usd > 0
        -- 2026-09-25 (#142): the same impossible-serial refusal as
        -- get_edition_recent_sales (base + parallels ceiling, NULL-escaping).
        AND (s.serial_number IS NULL
             OR ed.circulation_count IS NULL OR ed.circulation_count <= 0
             OR s.serial_number <= ed.circulation_count
             OR s.serial_number <= (
                  SELECT sum(e2.circulation_count) FROM editions e2
                  WHERE e2.collection_id = p_collection_id
                    AND e2.circulation_count > 0
                    AND split_part(e2.external_id, '::', 1) = split_part((SELECT external_id FROM ed), '::', 1)))
      GROUP BY 1
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(bucketed.*) ORDER BY bucketed.bucket), '[]'::jsonb)
    INTO result
    FROM bucketed;
  END IF;

  RETURN result;
END
$function$;
