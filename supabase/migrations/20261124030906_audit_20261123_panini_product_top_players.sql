-- audit_20261123: Panini PRODUCT page "Top Players" (2026-11-23 evening, Panini parity pass 2; Trevor: "Do it all").
--
-- Top Shot's series page (the product page's counterpart) lists "Top Players in this Series" — editions and FMV total
-- per player. The Panini product page listed sets, most valuable editions, top sales and packs, but no players.
-- Same figures: per player, the product's catalogued editions (every product_set_id the product NAME carries, from
-- panini_product_rollup — the page's own grain) and the sum of their current FMVs (edition_fmv_current, the price
-- every Panini page shows; an unpriced edition is counted, never summed as $0 — `priced_editions` says how many
-- carry a price). Ordered by FMV total. Measured 11-23 on 2026 WC Soccer (5,362 editions, 658 players): 47k shared
-- hits / 208 ms — read once per ISR window (revalidate 1800 s), so no rollup column is added.
-- NULL = no such product slug; '[]' = a product whose editions carry no player.
-- Revert: DROP FUNCTION public.get_panini_product_top_players(text, integer);

-- anon-exec: revoked (get_panini_product_top_players) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_panini_product_top_players(p_slug text, p_limit integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT r.product_set_ids FROM public.panini_product_rollup r WHERE r.slug = p_slug LIMIT 1
  ), per AS (
    SELECT btrim(pe.player_name) AS player_name,
           count(*)::int AS editions,
           count(*) FILTER (WHERE f.fmv_usd > 0)::int AS priced_editions,
           round(sum(f.fmv_usd) FILTER (WHERE f.fmv_usd > 0), 2) AS fmv_total_usd
      FROM r
      JOIN public.panini_editions pe ON pe.product_set_id = ANY (r.product_set_ids)
      JOIN public.editions e
        ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND e.external_id = pe.external_id
      LEFT JOIN public.edition_fmv_current f ON f.edition_id = e.id
     WHERE nullif(btrim(pe.player_name), '') IS NOT NULL
     GROUP BY 1
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM r) THEN NULL ELSE COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'player_name', x.player_name, 'editions', x.editions,
             'priced_editions', x.priced_editions, 'fmv_total_usd', x.fmv_total_usd)
           ORDER BY x.fmv_total_usd DESC NULLS LAST, x.editions DESC, x.player_name)
      FROM (SELECT * FROM per ORDER BY fmv_total_usd DESC NULLS LAST, editions DESC, player_name
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 12), 1), 50)) x), '[]'::jsonb) END
$function$;

REVOKE ALL ON FUNCTION public.get_panini_product_top_players(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_product_top_players(text, integer) TO service_role;

COMMENT ON FUNCTION public.get_panini_product_top_players(text, integer) IS
  'Panini product page Top Players (2026-11-23): per player, the product''s catalogued editions and the sum of their current FMVs (unpriced editions counted, not summed), FMV total first. NULL = unknown product slug.';
