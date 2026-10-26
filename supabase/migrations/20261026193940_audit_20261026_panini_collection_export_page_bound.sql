-- 2026-10-26: full-collection CSV for the Panini Collection tab. The tab loads the highest-FMV 500
-- (profile) / 200 (seen) cards only, so its CSV covered at most 500 of a 21,745-card profile. This
-- pages EVERY card on a unique key (sku) for /api/panini-collection/export, which streams them all or
-- answers 503 — never a partial file.
--
-- Same source rule as the tab and panini_holdings_breakdown, never mixed: the public PROFILE as of the
-- last walk (panini_user_holdings minus cards the marketplace now shows under another owner) when a walk
-- has read cards for the name, else the cards RPC has SEEN under it (panini_card_serials.owner, burnt
-- serials excluded). FMV is the edition's current FMV, NULL when unpriced (never 0). No confidence.
--
-- v2 (same day): each branch is ORDERed and LIMITed itself, so the profile branch walks the
-- (username, url_key) primary key and stops at the page size instead of joining every remaining
-- card before the sort — the first page of a 21,745-card profile hit the route's read bound cold.
-- The username is compared inline (not through a CTE join) so the key equality is plannable.
CREATE OR REPLACE FUNCTION public.panini_collection_export(
  p_username text,
  p_after_sku text DEFAULT NULL,
  p_limit integer DEFAULT 1000
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH u AS (SELECT lower(btrim(p_username)) AS username),
  use_profile AS (
    SELECT EXISTS (SELECT 1 FROM panini_user_holdings h, u WHERE h.username = u.username) AS yes
  ),
  prof AS (
    SELECT h.url_key AS sku, coalesce(s.edition_external_id, h.psku) AS ed,
           coalesce(pe.player_name, h.athlete) AS player_name,
           coalesce(pe.set_name, h.cardset) AS set_name,
           h.sport, pe.product_set_id,
           coalesce(h.serial_number, s.serial_number) AS serial_number,
           coalesce(h.mint_cap, s.mint_cap) AS mint_cap,
           (coalesce(s.is_listed, false) AND s.price_usd > 0 AND lower(s.owner) = lower(btrim(p_username))) AS is_listed,
           CASE WHEN s.is_listed AND s.price_usd > 0 AND lower(s.owner) = lower(btrim(p_username)) THEN s.price_usd END AS ask_usd,
           s.last_sale_usd, s.last_sale_at,
           coalesce(s.is_number_one, false) AS is_number_one,
           coalesce(s.is_jersey_mint, false) AS is_jersey_mint,
           coalesce(s.is_perfect_mint, false) AS is_perfect_mint,
           (pe.external_id IS NOT NULL) AS catalogued
    FROM panini_user_holdings h
    LEFT JOIN panini_card_serials s ON s.sku = h.url_key
    LEFT JOIN panini_editions pe ON pe.external_id = coalesce(s.edition_external_id, h.psku)
    WHERE h.username = lower(btrim(p_username))
      AND (SELECT yes FROM use_profile)
      AND (p_after_sku IS NULL OR h.url_key > p_after_sku)
      AND NOT (coalesce(s.owner, '') <> '' AND lower(s.owner) <> lower(btrim(p_username)) AND s.captured_at > h.last_seen_at)
    ORDER BY h.url_key
    LIMIT LEAST(GREATEST(coalesce(p_limit, 1000), 1), 1000)
  ),
  seen AS (
    SELECT s.sku, s.edition_external_id AS ed, pe.player_name, pe.set_name, NULL::text AS sport, pe.product_set_id,
           s.serial_number, s.mint_cap,
           (s.is_listed AND s.price_usd > 0) AS is_listed,
           CASE WHEN s.is_listed AND s.price_usd > 0 THEN s.price_usd END AS ask_usd,
           s.last_sale_usd, s.last_sale_at,
           coalesce(s.is_number_one, false), coalesce(s.is_jersey_mint, false), coalesce(s.is_perfect_mint, false),
           (pe.external_id IS NOT NULL) AS catalogued
    FROM panini_card_serials s
    LEFT JOIN panini_editions pe ON pe.external_id = s.edition_external_id
    WHERE s.owner <> '' AND lower(s.owner) = lower(btrim(p_username))
      AND NOT (SELECT yes FROM use_profile)
      AND s.serial_state IS DISTINCT FROM 'BURNT'
      AND (p_after_sku IS NULL OR s.sku > p_after_sku)
    ORDER BY s.sku
    LIMIT LEAST(GREATEST(coalesce(p_limit, 1000), 1), 1000)
  ),
  page AS (
    SELECT * FROM (SELECT * FROM prof UNION ALL SELECT * FROM seen) a
    ORDER BY a.sku
    LIMIT LEAST(GREATEST(coalesce(p_limit, 1000), 1), 1000)
  ),
  product_sport AS (
    SELECT DISTINCT ON (x.set_id) x.set_id, r.sport
    FROM panini_product_rollup r CROSS JOIN LATERAL unnest(r.product_set_ids) AS x(set_id)
    WHERE r.sport IS NOT NULL
    ORDER BY x.set_id, r.sport
  )
  SELECT jsonb_build_object(
    'username', (SELECT username FROM u),
    'source', CASE WHEN (SELECT yes FROM use_profile) THEN 'profile' ELSE 'seen' END,
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'sku', p.sku, 'edition_key', p.ed, 'player', p.player_name, 'set', p.set_name,
               'sport', coalesce(p.sport, tk.sport, ps.sport),
               'serial', p.serial_number, 'mint_cap', p.mint_cap,
               'is_listed', p.is_listed, 'ask_usd', p.ask_usd,
               'last_sale_usd', p.last_sale_usd, 'last_sale_at', p.last_sale_at,
               'is_number_one', p.is_number_one, 'is_jersey_mint', p.is_jersey_mint, 'is_perfect_mint', p.is_perfect_mint,
               'catalogued', p.catalogued,
               'fmv_usd', CASE WHEN f.fmv_usd > 0 THEN f.fmv_usd END)
             ORDER BY p.sku)
      FROM page p
      LEFT JOIN editions e ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid AND e.external_id = p.ed
      LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
      LEFT JOIN panini_edition_team_keys tk ON tk.external_id = p.ed
      LEFT JOIN product_sport ps ON ps.set_id = p.product_set_id
    ), '[]'::jsonb)
  )
$function$;

-- anon-exec: revoked — panini_collection_export is service-role only (/api/panini-collection/export calls it).
REVOKE EXECUTE ON FUNCTION public.panini_collection_export(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_collection_export(text, text, integer) TO service_role;
