-- audit_20261123: Disney Pinnacle CHARACTER CHECKLIST — the Top Shot player checklist (owned vs missing,
-- cost to complete) for a Pinnacle character, on the render grain (2026-11-23, Pinnacle roadmap pass).
--
-- Why its own function: get_player_checklist reads the shared `editions` table and RETURNS '[]' for
-- Pinnacle by design (a pin is a pinnacle_catalog row keyed by render_id; pinnacle_editions is
-- set-level and matches no held key — CLAUDE.md "Disney Pinnacle grain"). The feature-parity matrix
-- (2026-11-09) listed "Player checklists: Pinnacle —".
--
-- Subject: a character = the `characters` TRAIT (never character_name, the pin's own name), matched the
-- same way get_pinnacle_character_top_collectors matches it (case/space-insensitive, plus a multi-
-- character pin's "A & B" / "A B" spelling). Every render of the character is listed, every printing.
--
-- Ownership (p_wallet given): copies in wallet_moments_cache scoped by collection_id AND render_id
-- (a moment_id is unique only within a collection, #142). `wallet_cached` says whether RPC holds ANY
-- Pinnacle row for that wallet — false means "not indexed", never "owns nothing".
--
-- Cost to complete — every missing pin gets ONE price and a SOURCE, and the sums are kept apart:
--   'ask'        live floor ask (pinnacle_catalog.floor_ask, latest sweep) within 3x the pin's FMV —
--                the same 3x sanity bound get_player_checklist puts on a live ask;
--   'fmv'        no live ask, or an ask above 3x FMV (a parked listing) -> the FMV, an estimate;
--   'ask_no_fmv' an ask on a pin that has never sold (mostly 1/1 Apex grails and young drops): no FMV
--                to check it against, so it is summed SEPARATELY and never folded into the headline
--                (measured 11-23: one $1,000,000 Apex ask was 99.7 % of Mickey Mouse's "cost");
--   NULL         neither -> UNPRICED, counted, never summed as $0.
-- No FMV confidence is returned (internal only, 10-18).
--
-- Served by the route's service-role read; anon/authenticated cannot execute.
-- Revert: DROP FUNCTION public.get_pinnacle_character_checklist(text, text);

-- anon-exec: revoked (get_pinnacle_character_checklist) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_pinnacle_character_checklist(p_character text, p_wallet text DEFAULT NULL)
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
     WHERE EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(p_character)))
        OR (cardinality(pc.characters) > 1
            AND lower(btrim(p_character)) IN (lower(array_to_string(pc.characters, ' & ')),
                                              lower(array_to_string(pc.characters, ' '))))
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
    'character', p_character,
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

REVOKE ALL ON FUNCTION public.get_pinnacle_character_checklist(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_character_checklist(text, text) TO service_role;

COMMENT ON FUNCTION public.get_pinnacle_character_checklist(text, text) IS
  'Disney Pinnacle character checklist (2026-11-23): every pin (render) of a character (characters trait), owned copies for p_wallet from wallet_moments_cache (collection-scoped), and the cost to complete by source: live ask within 3x FMV, else FMV, an ask on a never-sold pin summed separately, unpriced pins counted but never summed. NULL when the character has no pins.';
