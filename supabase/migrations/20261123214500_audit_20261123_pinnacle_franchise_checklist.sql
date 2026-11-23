-- audit_20261123: Disney Pinnacle FRANCHISE CHECKLIST — the team checklist's job on the render grain
-- (2026-11-23, Pinnacle parity pass 2). Generalises 20261123200500's character checklist into one
-- function keyed on the subject KIND:
--   get_pinnacle_checklist('character', name, wallet) — the `characters` trait (unchanged semantics);
--   get_pinnacle_checklist('franchise', name, wallet) — the `franchises` trait, compared with ™/®/©
--     stripped (franchise page names and slugs drop them; the catalog keeps "Star Wars™").
-- Any other kind matches nothing → NULL (the route 404s), never a substituted subject.
-- get_pinnacle_character_checklist stays as a thin wrapper so its route and pin keep working.
-- Same cost rules, same privileges (service_role only). Largest franchise on 11-23: Star Wars, 681 pins.
--
-- Revert: re-apply 20261123200500 (the wrapper's original body), then
--   DROP FUNCTION public.get_pinnacle_checklist(text, text, text);

-- anon-exec: revoked (get_pinnacle_checklist) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: revoked (get_pinnacle_character_checklist) — re-created as a wrapper; REVOKE re-asserted below.
CREATE OR REPLACE FUNCTION public.get_pinnacle_checklist(p_kind text, p_name text, p_wallet text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT pc.render_id, pc.character_name, btrim(pc.set_name) AS set_name, pc.series_name, pc.edition_type,
           pc.variant, pc.parallel_type, pc.printing, pc.total_minted, pc.is_chaser, pc.thumbnail_url,
           CASE WHEN pc.fmv_usd > 0 THEN pc.fmv_usd END   AS fmv_usd,
           CASE WHEN pc.floor_ask > 0 THEN pc.floor_ask END AS floor_ask_usd
      FROM public.pinnacle_catalog pc
     WHERE (p_kind = 'character'
            AND (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(p_name)))
                 OR (cardinality(pc.characters) > 1
                     AND lower(btrim(p_name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                  lower(array_to_string(pc.characters, ' '))))))
        OR (p_kind = 'franchise'
            -- franchise slugs and page names drop ™/®/© (CLAUDE.md "Disney Pinnacle grain").
            AND EXISTS (SELECT 1 FROM unnest(pc.franchises) f
                         WHERE lower(btrim(regexp_replace(f, '[™®©]', '', 'g'))) = lower(btrim(regexp_replace(p_name, '[™®©]', '', 'g')))))
  ), priced AS (
    SELECT r.*,
           CASE WHEN floor_ask_usd IS NOT NULL AND fmv_usd IS NOT NULL AND floor_ask_usd <= fmv_usd * 3 THEN floor_ask_usd
                WHEN fmv_usd IS NOT NULL THEN fmv_usd
                WHEN floor_ask_usd IS NOT NULL THEN floor_ask_usd END AS cost_usd,
           CASE WHEN floor_ask_usd IS NOT NULL AND fmv_usd IS NOT NULL AND floor_ask_usd <= fmv_usd * 3 THEN 'ask'
                WHEN fmv_usd IS NOT NULL THEN 'fmv'
                WHEN floor_ask_usd IS NOT NULL THEN 'ask_no_fmv' END AS cost_source
      FROM r
  ), owned AS (
    SELECT w.render_id, count(*)::int AS copies
      FROM public.wallet_moments_cache w
     WHERE p_wallet IS NOT NULL
       AND w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
       AND w.wallet_address = p_wallet
       AND w.render_id IN (SELECT render_id FROM r)
     GROUP BY w.render_id
  ), rows AS (
    SELECT p.*,
           CASE WHEN p_wallet IS NULL THEN NULL ELSE COALESCE(o.copies, 0) END AS owned_count
      FROM priced p LEFT JOIN owned o ON o.render_id = p.render_id
  ), need AS (
    -- With a wallet: the pins it is missing. Without one: the whole character at today's prices.
    SELECT * FROM rows WHERE p_wallet IS NULL OR owned_count = 0
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM r) THEN NULL ELSE jsonb_build_object(
    'kind', p_kind,
    'character', p_name,
    'wallet', p_wallet,
    'wallet_cached', CASE WHEN p_wallet IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM public.wallet_moments_cache w
         WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AND w.wallet_address = p_wallet) END,
    'total', (SELECT count(*) FROM r),
    'owned', CASE WHEN p_wallet IS NULL THEN NULL ELSE (SELECT count(*) FROM rows WHERE owned_count > 0) END,
    'missing', CASE WHEN p_wallet IS NULL THEN NULL ELSE (SELECT count(*) FROM need) END,
    'cost_at_ask_usd',        round(COALESCE((SELECT sum(cost_usd) FROM need WHERE cost_source = 'ask'), 0), 2),
    'priced_at_ask',          (SELECT count(*) FROM need WHERE cost_source = 'ask'),
    'cost_at_fmv_usd',        round(COALESCE((SELECT sum(cost_usd) FROM need WHERE cost_source = 'fmv'), 0), 2),
    'priced_at_fmv',          (SELECT count(*) FROM need WHERE cost_source = 'fmv'),
    'cost_ask_no_fmv_usd',    round(COALESCE((SELECT sum(cost_usd) FROM need WHERE cost_source = 'ask_no_fmv'), 0), 2),
    'priced_ask_no_fmv',      (SELECT count(*) FROM need WHERE cost_source = 'ask_no_fmv'),
    'unpriced',               (SELECT count(*) FROM need WHERE cost_source IS NULL),
    'pins', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'render_id', x.render_id, 'name', x.character_name, 'set_name', x.set_name,
               'series_name', x.series_name, 'edition_type', x.edition_type, 'variant', x.variant,
               'parallel_type', x.parallel_type, 'printing', x.printing, 'total_minted', x.total_minted,
               'is_chaser', x.is_chaser, 'thumbnail_url', x.thumbnail_url,
               'fmv_usd', x.fmv_usd, 'floor_ask_usd', x.floor_ask_usd,
               'cost_usd', x.cost_usd, 'cost_source', x.cost_source, 'owned_count', x.owned_count)
             ORDER BY x.set_name NULLS LAST, x.edition_type NULLS LAST, x.variant NULLS LAST, x.render_id)
        FROM rows x), '[]'::jsonb)
  ) END
$function$;


CREATE OR REPLACE FUNCTION public.get_pinnacle_character_checklist(p_character text, p_wallet text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.get_pinnacle_checklist('character', p_character, p_wallet)
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_checklist(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_checklist(text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.get_pinnacle_character_checklist(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_character_checklist(text, text) TO service_role;

COMMENT ON FUNCTION public.get_pinnacle_checklist(text, text, text) IS
  'Disney Pinnacle checklist (2026-11-23) for a character (characters trait) or franchise (franchises trait, ™/®/© stripped): every pin, owned copies for p_wallet (collection-scoped wmc), cost to complete by source (ask <= 3x FMV, else FMV; never-sold asks and unpriced pins apart). NULL when the subject has no pins or the kind is unknown.';
