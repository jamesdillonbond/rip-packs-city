-- audit_20261123: Panini FRANCHISE CHECKLIST — the team checklist (owned vs missing, cost to complete) for the
-- Panini panel of a cross-collection franchise hub (/teams/<league>/<slug>), by PANINI USERNAME (2026-11-23 evening,
-- Panini parity pass 2; Trevor: "Do it all").
--
-- Panini has no per-collection team pages (its editions carry no team), so the shared TeamChecklist cannot serve it;
-- the hub panel listed the franchise's Panini cards but scored no ownership. Population = the panel's own
-- (get_panini_franchise_editions: panini_edition_team_keys @> 'LEAGUE:slug', catalogued with art).
-- Ownership, cost-to-complete sources and three states are get_panini_player_checklist's (20261124013251), verbatim.
-- Measured 11-23 on NBA:lakers (737 cards, the largest key) — see the ledger entry.
--
-- Served by the route's service-role read; anon/authenticated cannot execute.
-- Revert: DROP FUNCTION public.get_panini_franchise_checklist(text, text, text);

-- anon-exec: revoked (get_panini_franchise_checklist) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_panini_franchise_checklist(p_league text, p_team_slug text, p_username text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH fk AS (
    SELECT upper(btrim(p_league)) || ':' || lower(btrim(p_team_slug)) AS key
  ), u AS (
    SELECT NULLIF(lower(btrim(p_username)), '') AS username
  ), ed AS (
    -- The hub panel's population (get_panini_franchise_editions): every edition the team map places on the
    -- franchise, catalogued with art.
    SELECT e.external_id::text AS external_id, e.name, e.player_name, e.thumbnail_url,
           pe.set_name, pe.parallel, pe.mint_cap, pe.tier::text AS tier, pr.name AS product_name,
           CASE WHEN f.fmv_usd > 0 THEN f.fmv_usd END AS fmv_usd
      FROM public.panini_edition_team_keys t
      JOIN fk ON t.franchise_keys @> ARRAY[fk.key]
      JOIN public.editions e
        ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND e.external_id = t.external_id
       AND e.thumbnail_url IS NOT NULL
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
    'franchise_key', (SELECT key FROM fk),
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
               'external_id', x.external_id, 'name', x.name, 'player_name', x.player_name, 'set_name', x.set_name, 'parallel', x.parallel,
               'product_name', x.product_name, 'tier', x.tier, 'mint_cap', x.mint_cap, 'thumbnail_url', x.thumbnail_url,
               'fmv_usd', x.fmv_usd, 'low_ask_usd', x.low_ask_usd,
               'cost_usd', x.cost_usd, 'cost_source', x.cost_source, 'owned_count', x.owned_count)
             ORDER BY x.fmv_usd DESC NULLS LAST, x.external_id)
        FROM priced x), '[]'::jsonb)
  ) END
$function$;

REVOKE ALL ON FUNCTION public.get_panini_franchise_checklist(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_franchise_checklist(text, text, text) TO service_role;

COMMENT ON FUNCTION public.get_panini_franchise_checklist(text, text, text) IS
  'Panini franchise checklist (2026-11-23): every card the franchise hub''s Panini panel lists (panini_edition_team_keys), owned copies for a Panini USERNAME (read public profile, else serials seen under the name — never mixed), cost to complete by source (as get_panini_player_checklist). NULL when the franchise has no mapped Panini cards.';
