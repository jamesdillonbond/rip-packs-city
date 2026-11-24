-- audit_20261123: Panini PLAYER CHECKLIST — the Top Shot player checklist (owned vs missing, cost to complete)
-- for a Panini player, by PANINI USERNAME (2026-11-23 evening, Panini parity pass; Trevor: "look for any feature
-- parity that we don't have setup on panini, that we already have for other collections").
--
-- Why its own function: get_player_checklist reads wallet_moments_cache, which holds no Panini rows — a Panini
-- owner is a USERNAME (lib/address.ts isPaniniUsername), never a wallet. The feature-parity matrix (11-09) listed
-- "Player checklists: Panini —".
--
-- Subject: the SAME editions the player page's grid lists (get_player_editions' non-Pinnacle arm: the Panini
-- `players` row matched by slug, then editions by player_id, or by player_name unless the edition is another person
-- with that name), joined to panini_editions for set / parallel / mint cap / product.
--
-- Ownership (p_username given) — the two sources panini_holdings_breakdown uses, never mixed:
--   'profile' a collector walk has read this username's public Panini profile (panini_user_holdings), minus a card
--             the serial read has since seen under another owner;
--   'seen'    otherwise, the serials RPC has read under the name (panini_card_serials.owner), burnt excluded —
--             a LOWER BOUND, and the client says so.
-- `username_seen` = false means RPC has read nothing under the name: "not seen", never "owns none".
--
-- Cost to complete — one price and a SOURCE per missing card, sums kept apart (the Pinnacle checklist's rule):
--   'ask'        lowest ask re-confirmed in the last 7 days (the board's rule) within 3x the edition FMV;
--   'fmv'        no confirmed ask, or an ask above 3x FMV -> the FMV, an estimate;
--   'ask_no_fmv' a confirmed ask on an edition with no FMV — summed separately, never in the headline;
--   NULL         neither -> UNPRICED, counted, never summed as $0.
-- No FMV confidence is returned (internal only, 10-18). Cost measured 11-23 (Lillard, 146 cards, a 222-card
-- profile): ~3.6k buffers, 0.5 s cold.
--
-- Served by the route's service-role read; anon/authenticated cannot execute.
-- Revert: DROP FUNCTION public.get_panini_player_checklist(text, text);

-- anon-exec: revoked (get_panini_player_checklist) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_panini_player_checklist(p_player_slug text, p_username text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH pl AS (
    SELECT p.id, p.name
      FROM public.players p
     WHERE p.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
            OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
     LIMIT 1
  ), u AS (
    SELECT NULLIF(lower(btrim(p_username)), '') AS username
  ), ed AS (
    SELECT e.external_id::text AS external_id, e.name, e.thumbnail_url,
           pe.set_name, pe.parallel, pe.mint_cap, pe.tier::text AS tier, pr.name AS product_name,
           CASE WHEN f.fmv_usd > 0 THEN f.fmv_usd END AS fmv_usd
      FROM pl
      JOIN public.editions e
        ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND (e.player_id = pl.id OR (e.player_name = pl.name AND NOT public.edition_player_is_other_person(e.player_id, pl.id)))
      JOIN public.panini_editions pe ON pe.external_id = e.external_id::text
      LEFT JOIN public.panini_products pr ON pr.set_id = pe.product_set_id
      LEFT JOIN public.edition_fmv_current f ON f.edition_id = e.id
  ), asks AS (
    SELECT ed.external_id, x.low_ask
      FROM ed
     CROSS JOIN LATERAL (
       SELECT min(s.price_usd) AS low_ask
         FROM public.panini_card_serials s
        WHERE s.edition_external_id = ed.external_id
          AND s.is_listed AND s.price_usd > 0 AND s.captured_at > now() - interval '7 days'
     ) x
  ), use_profile AS (
    SELECT EXISTS (SELECT 1 FROM public.panini_user_holdings h, u WHERE h.username = u.username) AS yes
  ), prof AS (
    SELECT coalesce(s.edition_external_id, h.psku) AS external_id
      FROM public.panini_user_holdings h
      JOIN u ON u.username = h.username
      LEFT JOIN public.panini_card_serials s ON s.sku = h.url_key
     WHERE (SELECT yes FROM use_profile)
       AND NOT (coalesce(s.owner, '') <> '' AND lower(s.owner) <> u.username AND s.captured_at > h.last_seen_at)
  ), seen AS (
    SELECT s.edition_external_id AS external_id
      FROM public.panini_card_serials s
      JOIN u ON s.owner <> '' AND lower(s.owner) = u.username
     WHERE NOT (SELECT yes FROM use_profile)
       AND s.serial_state IS DISTINCT FROM 'BURNT'
  ), owned AS (
    SELECT o.external_id, count(*)::int AS copies
      FROM (SELECT external_id FROM prof UNION ALL SELECT external_id FROM seen) o
     WHERE o.external_id IN (SELECT external_id FROM ed)
     GROUP BY o.external_id
  ), priced AS (
    SELECT ed.*, a.low_ask AS low_ask_usd,
           CASE WHEN a.low_ask IS NOT NULL AND ed.fmv_usd IS NOT NULL AND a.low_ask <= ed.fmv_usd * 3 THEN a.low_ask
                WHEN ed.fmv_usd IS NOT NULL THEN ed.fmv_usd
                WHEN a.low_ask IS NOT NULL THEN a.low_ask END AS cost_usd,
           CASE WHEN a.low_ask IS NOT NULL AND ed.fmv_usd IS NOT NULL AND a.low_ask <= ed.fmv_usd * 3 THEN 'ask'
                WHEN ed.fmv_usd IS NOT NULL THEN 'fmv'
                WHEN a.low_ask IS NOT NULL THEN 'ask_no_fmv' END AS cost_source,
           CASE WHEN (SELECT username FROM u) IS NULL THEN NULL ELSE COALESCE(o.copies, 0) END AS owned_count
      FROM ed
      LEFT JOIN asks a ON a.external_id = ed.external_id
      LEFT JOIN owned o ON o.external_id = ed.external_id
  ), need AS (
    -- With a username: the cards it is missing. Without one: every card at today's prices.
    SELECT * FROM priced WHERE (SELECT username FROM u) IS NULL OR owned_count = 0
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ed) THEN NULL ELSE jsonb_build_object(
    'player', (SELECT name FROM pl),
    'username', (SELECT username FROM u),
    'source', CASE WHEN (SELECT username FROM u) IS NULL THEN NULL
                   WHEN (SELECT yes FROM use_profile) THEN 'profile' ELSE 'seen' END,
    'username_seen', CASE WHEN (SELECT username FROM u) IS NULL THEN NULL
                          WHEN (SELECT yes FROM use_profile) THEN true
                          ELSE EXISTS (SELECT 1 FROM public.panini_card_serials s, u
                                        WHERE s.owner <> '' AND lower(s.owner) = u.username) END,
    'profile_read_at', CASE WHEN (SELECT yes FROM use_profile) THEN (
        SELECT coalesce(w.last_complete_at, w.last_walk_at) FROM public.panini_collector_walks w, u
         WHERE w.username = u.username) END,
    'total', (SELECT count(*) FROM ed),
    'owned', CASE WHEN (SELECT username FROM u) IS NULL THEN NULL ELSE (SELECT count(*) FROM priced WHERE owned_count > 0) END,
    'missing', CASE WHEN (SELECT username FROM u) IS NULL THEN NULL ELSE (SELECT count(*) FROM need) END,
    'cost_at_ask_usd',     round(COALESCE((SELECT sum(cost_usd) FROM need WHERE cost_source = 'ask'), 0), 2),
    'priced_at_ask',       (SELECT count(*) FROM need WHERE cost_source = 'ask'),
    'cost_at_fmv_usd',     round(COALESCE((SELECT sum(cost_usd) FROM need WHERE cost_source = 'fmv'), 0), 2),
    'priced_at_fmv',       (SELECT count(*) FROM need WHERE cost_source = 'fmv'),
    'cost_ask_no_fmv_usd', round(COALESCE((SELECT sum(cost_usd) FROM need WHERE cost_source = 'ask_no_fmv'), 0), 2),
    'priced_ask_no_fmv',   (SELECT count(*) FROM need WHERE cost_source = 'ask_no_fmv'),
    'unpriced',            (SELECT count(*) FROM need WHERE cost_source IS NULL),
    'cards', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'external_id', x.external_id, 'name', x.name, 'set_name', x.set_name, 'parallel', x.parallel,
               'product_name', x.product_name, 'tier', x.tier, 'mint_cap', x.mint_cap, 'thumbnail_url', x.thumbnail_url,
               'fmv_usd', x.fmv_usd, 'low_ask_usd', x.low_ask_usd,
               'cost_usd', x.cost_usd, 'cost_source', x.cost_source, 'owned_count', x.owned_count)
             ORDER BY x.product_name NULLS LAST, x.set_name NULLS LAST, x.mint_cap DESC NULLS LAST, x.external_id)
        FROM priced x), '[]'::jsonb)
  ) END
$function$;

REVOKE ALL ON FUNCTION public.get_panini_player_checklist(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_player_checklist(text, text) TO service_role;

COMMENT ON FUNCTION public.get_panini_player_checklist(text, text) IS
  'Panini player checklist (2026-11-23): every card the player page lists, owned copies for a Panini USERNAME (the read public profile, else serials seen under the name — never mixed), and the cost to complete by source: 7-day confirmed ask within 3x FMV, else FMV, an ask on an unpriced edition summed separately, unpriced cards counted but never summed. NULL when the player has no Panini cards.';
