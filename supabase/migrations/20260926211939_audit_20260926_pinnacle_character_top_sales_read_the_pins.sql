-- audit_20260926_pinnacle_character_top_sales_read_the_pins
--
-- WHY. A Pinnacle character page's "Top sales" read pinnacle_sales joined to
-- pinnacle_editions WHERE character_name = the character. pinnacle_editions is
-- set-level (one character per legacy key), so the 265 characters that got a
-- page from the catalog on 2026-09-26 (20260926193316) — and every character
-- whose pins sit under another character's key — rendered "No recorded sales
-- yet": a CONCLUDING empty state over real sales.
--
-- WHAT. The Pinnacle branch reads the character's pins from pinnacle_catalog
-- (the Characters-trait match get_player_editions uses, duos by joined name)
-- and their sales by pinnacle_sales.render_id through a per-pin LATERAL on
-- idx_pinnacle_sales_render_id (measured 2,088 buffers / 28 ms for Mickey Mouse,
-- 54 pins; a plain join seq-scanned 200k rows, 7,578 buffers). Rows route to the
-- pin (render_id) and carry edition_name = the pin's name. A character the
-- catalog does not name falls through to the old read; every non-Pinnacle line
-- is byte-for-byte the live body (base prosrc md5 227db08f704c57791d50d7c9a984fe14;
-- the repo copy in 20260831183251 predates the live unaccent lane).
--
-- REVERT: re-apply the base body (this file minus the IF EXISTS … END IF block).

-- anon-exec: unchanged (get_player_top_sales) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.get_player_top_sales(p_collection_id uuid, p_player_slug text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_player        RECORD;
  result          jsonb;
BEGIN
  SELECT p.* INTO v_player
  FROM players p
  WHERE p.collection_id = p_collection_id
    AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
  LIMIT 1;

  IF v_player IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the character's PINS from the render catalog — the same
    -- Characters-trait match get_player_editions uses (duos by joined name) —
    -- and their sales by pinnacle_sales.render_id (set on 200,205 of 200,214).
    -- The old read matched pinnacle_editions.character_name, which names ONE
    -- character per set-level key, so a character the catalog names but no
    -- legacy row does (265 pages since 20260926193316) read "No recorded sales
    -- yet" over real sales. Per-pin LATERAL on idx_pinnacle_sales_render_id:
    -- measured 2,088 buffers for Mickey Mouse (54 pins) against 7,578 for a
    -- join that seq-scans the table. A character the catalog does not name
    -- falls through to the old read, unchanged.
    IF EXISTS (
      SELECT 1 FROM pinnacle_catalog pc
      WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
    ) THEN
      WITH pins AS (
        SELECT pc.render_id, pc.character_name, pc.set_name, pc.variant, pc.thumbnail_url
        FROM pinnacle_catalog pc
        WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
      ),
      top_sales AS (
        SELECT
          s.id::text                 AS sale_id,
          s.edition_id               AS edition_id,
          p.render_id                AS route_slug,
          v_player.name              AS player_name,
          btrim(p.character_name) || ' (' || p.variant || ')' AS edition_name,
          btrim(p.set_name)          AS set_name,
          p.variant                  AS tier,
          p.thumbnail_url,
          s.serial_number,
          s.sale_price_usd           AS price_usd,
          NULL::text                 AS marketplace,
          s.source                   AS source,
          s.buyer_address::text      AS buyer_address,
          s.seller_address::text     AS seller_address,
          s.nft_id::text             AS nft_id,
          NULL::text                 AS transaction_hash,
          s.sold_at
        FROM pins p
        CROSS JOIN LATERAL (
          SELECT ps.id, ps.edition_id, ps.serial_number, ps.sale_price_usd, ps.source,
                 ps.buyer_address, ps.seller_address, ps.nft_id, ps.sold_at
          FROM pinnacle_sales ps
          WHERE ps.render_id = p.render_id
          ORDER BY ps.sale_price_usd DESC NULLS LAST, ps.sold_at DESC, ps.id
          LIMIT v_safe_limit
        ) s
        ORDER BY s.sale_price_usd DESC NULLS LAST, s.sold_at DESC, s.id
        LIMIT v_safe_limit
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
      RETURN result;
    END IF;

    -- Pinnacle path: pinnacle_sales joined to pinnacle_editions on text edition_id
    WITH player_editions AS (
      SELECT id, character_name, set_name, variant_type, thumbnail_url
      FROM pinnacle_editions
      WHERE character_name = v_player.name
    ),
    top_sales AS (
      SELECT
        ps.id::text                AS sale_id,
        pe.id                      AS edition_id,
        pe.id                      AS route_slug,
        pe.character_name          AS player_name,
        pe.set_name,
        pe.variant_type            AS tier,
        pe.thumbnail_url,
        ps.serial_number,
        ps.sale_price_usd          AS price_usd,
        NULL::text                 AS marketplace,
        ps.source                  AS source,
        ps.buyer_address::text     AS buyer_address,
        ps.seller_address::text    AS seller_address,
        ps.nft_id::text            AS nft_id,
        NULL::text                 AS transaction_hash,
        ps.sold_at
      FROM pinnacle_sales ps
      JOIN player_editions pe ON pe.id = ps.edition_id
      ORDER BY ps.sale_price_usd DESC NULLS LAST, ps.sold_at DESC
      LIMIT v_safe_limit
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
  ELSE
    -- Standard path. 2026-08-31: the per-edition LATERAL is LOAD-BEARING — it is
    -- what lets `sales_<year>_edition_id_price_usd_idx` supply the ordering as a
    -- Merge Append of ordered index scans. The `sold_at DESC` tiebreak INSIDE the
    -- LATERAL is equally load-bearing: without it, an edition whose sales tie at
    -- the cut price truncates arbitrarily and the result set changes.
    WITH player_editions AS (
      SELECT id, name, external_id, set_name, tier::text AS tier, thumbnail_url
      FROM editions
      WHERE collection_id = p_collection_id
        AND (player_id = v_player.id OR player_name = v_player.name)
    ),
    top_sales AS (
      SELECT
        sa.id::text                          AS sale_id,
        sa.edition_id::text                  AS edition_id,
        COALESCE(pe.external_id, pe.id::text) AS route_slug,
        v_player.name                        AS player_name,
        pe.name                              AS edition_name,
        pe.set_name,
        pe.tier,
        pe.thumbnail_url,
        sa.serial_number,
        sa.price_usd,
        sa.marketplace::text                 AS marketplace,
        sa.source                            AS source,
        sa.buyer_address::text               AS buyer_address,
        sa.seller_address::text              AS seller_address,
        sa.nft_id::text                      AS nft_id,
        sa.transaction_hash::text            AS transaction_hash,
        sa.sold_at
      FROM player_editions pe
      JOIN LATERAL (
        SELECT s.id, s.edition_id, s.serial_number, s.price_usd, s.marketplace,
               s.source, s.buyer_address, s.seller_address, s.nft_id,
               s.transaction_hash, s.sold_at
        FROM sales s
        WHERE s.edition_id = pe.id
        ORDER BY s.price_usd DESC, s.sold_at DESC
        LIMIT v_safe_limit
      ) sa ON true
      ORDER BY sa.price_usd DESC NULLS LAST, sa.sold_at DESC
      LIMIT v_safe_limit
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
  END IF;

  RETURN result;
END;
$function$;
