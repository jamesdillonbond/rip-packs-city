-- 2026-10-25 (PT) — get_edition_recent_sales flags buyback purchases.
--
-- WHY. A production HTML sweep (10-25 ~1:53 PM PT) read /nba-top-shot/edition/169:6329
-- stating "30d Sales 0 · 86d since last" above an Activity table whose newest row is a
-- $229 sale on Oct 20. That row's buyer is TopShot_Buyback_2 (buyback_wallets), and
-- sales_market — the source of the 30d count, the last-sale age and FMV — excludes
-- purchases by a buyback wallet, deliberately. The stats were right; the table listed the
-- excluded sale with nothing saying so. 30 d: 2,076 of 74,097 Top Shot sales, on 785
-- editions, were buyback purchases.
--
-- WHAT. One column in `enriched`: `buyback` (EXISTS on buyback_wallets' PK
-- (collection_id, wallet_address), same predicate as sales_market, at most p_limit
-- probes). The Activity table renders a "Buyback" tag on those rows. Nothing else
-- changes: the Pinnacle branch (no buyback wallets; the field is absent there), recent,
-- sub_names, the signature, RETURNS, STABLE, SECURITY DEFINER, search_path,
-- statement_timeout and the ACLs.
-- anon-exec: unchanged (get_edition_recent_sales) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- Revert: re-apply the body from
--   supabase/migrations/20261004153000_audit_20261004_edition_recent_sales_reads_only_the_page_not_every_sale.sql
-- and repoint the pin (supabase/tests/get_edition_recent_sales.sql, db-invariants-drift-guard).

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_edition_recent_sales(uuid,text,integer,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '1608c476c286a9812931add2f82b19d5' THEN
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
      -- 2026-10-04: the page is cut INSIDE a LATERAL, so each yearly partition's
      -- (edition_id, sold_at) index is read newest-first and the scan stops at
      -- the page. As a plain join the planner fetched EVERY sale of the edition
      -- and sorted them (4,357 rows / 3,612 buffers for 30 on a UFC edition).
      CROSS JOIN LATERAL (
        SELECT s.* FROM sales s
        WHERE s.edition_id = ed.id
          -- 2026-09-25 (#142): refuse a sale whose serial cannot exist in this
          -- edition. The ceiling is base + parallels (serials are shared across a
          -- (set, play) and its subeditions — 20260922200554), which equals the
          -- chain's getNumMomentsInEdition. Subtractive and NULL-escaping; the
          -- total is an InitPlan, reached only for a serial above the row's own
          -- circulation, so a normal page load never pays for it.
          AND (s.serial_number IS NULL
            OR ed.circulation_count IS NULL OR ed.circulation_count <= 0
            OR s.serial_number <= ed.circulation_count
            OR s.serial_number <= (
                 SELECT sum(e2.circulation_count) FROM editions e2
                 WHERE e2.collection_id = p_collection_id
                   AND e2.circulation_count > 0
                   AND split_part(e2.external_id, '::', 1) = split_part(ed.external_id, '::', 1)))
        -- id breaks a same-second tie, so OFFSET pages cannot overlap or skip.
        ORDER BY s.sold_at DESC, s.id DESC
        LIMIT v_safe_limit OFFSET v_safe_offset
      ) sa
      ORDER BY sa.sold_at DESC
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
        -- 2026-10-25: a purchase by the collection's own buyback wallet. sales_market
        -- (every 30d count, last-sale age and FMV input) excludes these, so the table
        -- flags them rather than show a sale the stats above it do not count.
        EXISTS (SELECT 1 FROM buyback_wallets b
                WHERE b.collection_id = p_collection_id
                  AND b.wallet_address = r.buyer_address) AS buyback,
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
