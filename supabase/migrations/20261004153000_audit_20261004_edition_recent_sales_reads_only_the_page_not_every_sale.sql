-- 2026-10-04 (PT) — get_edition_recent_sales: cut the page inside a LATERAL so it
-- reads the page, not every sale of the edition.
--
-- WHY. Vercel, 24 h to 7:35 AM PT 10-04: four `[entity-section] edition recent sales
-- get_edition_recent_sales failed after retries: canceling statement due to statement
-- timeout — degrading to empty` on UFC edition pages (cache=MISS, 9:57 PM–1:08 AM PT).
-- The section degrades honestly (lib/entity/section-empty-copy.ts), but the sales table
-- is gone for that visitor. The function's own plan joins `ed` to `sales` and only then
-- applies ORDER BY sold_at DESC LIMIT, so Postgres fetched EVERY sale of the edition and
-- sorted them. Joe Lauzon UFC FN 2015 (4,357 sales): 3,612 buffers for 30 rows. Four UFC
-- editions through the function, cold: 7.1 s, 14,913 blocks read. One cold call past the
-- 8 s statement_timeout on a busy night is the failure above.
--
-- WHAT. Only the `recent` CTE's access path moves: the sales read is a CROSS JOIN LATERAL
-- holding the same #142 predicate, ORDER BY and LIMIT/OFFSET. `ed` is at most one row
-- (LIMIT 1), so cutting inside the lateral is the same cut. The planner can then walk each
-- yearly partition's (edition_id, sold_at) index newest-first and stop at the page.
-- `(SELECT external_id FROM ed)` became `ed.external_id` (the same row). The lateral also
-- orders by `s.id DESC` after sold_at: (id, sold_at) is the PK, so a same-second tie now has a
-- fixed order and an OFFSET page cannot repeat or skip a sale (before, 2 of 123 sampled pages
-- picked a different tied row at the edge; neither body was wrong, both were arbitrary). Nothing else
-- changes: the Pinnacle branch, sub_names, enriched, the signature, RETURNS, STABLE,
-- SECURITY DEFINER, search_path, statement_timeout and the ACLs.
--
-- MEASURED (same edition, same instrument): 3,612 -> 46 buffers for the 30 rows.
-- Equivalence and the post-apply numbers: see the ledger entry of 2026-10-04 (~8:45 AM PT).
-- anon-exec: unchanged (get_edition_recent_sales) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- Revert: re-apply the body from
--   supabase/migrations/20261003033402_audit_20261002_edition_recent_sales_sub_names_reads_only_the_page_s_subeditions.sql
-- and repoint the pin (supabase/tests/get_edition_recent_sales.sql, db-invariants-drift-guard).

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_edition_recent_sales(uuid,text,integer,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '5a1cd663f42938ee53ae1ff7c12ed0f0' THEN
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
