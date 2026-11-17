-- 2026-10-15 (Claude Code cloud). panini_profile_holdings: a card the marketplace shows changed hands
-- AFTER our collector walk last saw it is no longer shown as held, and the response says how many.
--
-- WHY. panini_collector_walk_ingest retires sold cards only on a COMPLETE walk. Three tracked profiles
-- (scottyj111, spinotron, timdunkin) are too large to read inside the per-walk cap, never complete, and so
-- are ADD-ONLY: sold cards stay listed as held indefinitely. panini_card_serials.owner is an independent
-- ownership read (the marketplace's current owner, stamped captured_at). Measured 10-15: rows whose serial
-- owner is set, differs from the profile, and was captured AFTER the walk last saw the card — scottyj111 61,
-- spinotron 1, timdunkin 1; every profile with a complete walk 0 (the control: the signal does not fire on
-- holdings a complete walk just confirmed). Excluding at READ time is reversible and deletes nothing; a later
-- walk that sees the card again (last_seen_at moves past captured_at) restores it.
--
-- Verified before apply on a pg_temp copy: complete-walk profiles byte-identical to the live body (bar the
-- new key); scottyj111 14,279 -> 14,218; spinotron 7,543 -> 7,542 (= the total its Panini profile reports).
--
-- anon-exec: intentional — same signature, ACL unchanged (service_role only) (panini_profile_holdings)
-- REVERT: re-apply the panini_profile_holdings body of 20260929024339 verbatim.
CREATE OR REPLACE FUNCTION public.panini_profile_holdings(p_username text, p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH u AS (SELECT lower(btrim(p_username)) AS username),
  walk AS (SELECT w.* FROM panini_collector_walks w, u WHERE w.username = u.username),
  base AS (
    SELECT h.*, s.edition_external_id, s.is_listed AS s_is_listed, s.owner AS s_owner, s.price_usd AS s_price_usd,
           s.is_number_one, s.is_jersey_mint, s.is_perfect_mint, s.is_special AS s_is_special,
           (coalesce(s.owner, '') <> '' AND lower(s.owner) <> u.username AND s.captured_at > h.last_seen_at) AS moved
    FROM panini_user_holdings h
    JOIN u ON u.username = h.username
    LEFT JOIN panini_card_serials s ON s.sku = h.url_key
  ),
  held AS (
    SELECT b.url_key, coalesce(b.edition_external_id, b.psku) AS psku, b.serial_number, b.mint_cap, b.last_seen_at,
           (b.s_is_listed AND lower(b.s_owner) = u.username) AS is_listed,
           CASE WHEN b.s_is_listed AND lower(b.s_owner) = u.username THEN b.s_price_usd END AS price_usd,
           b.is_number_one, b.is_jersey_mint, b.is_perfect_mint,
           coalesce(b.s_is_special, false) AS is_special,
           coalesce(pe.player_name, b.athlete) AS player_name,
           coalesce(pe.set_name, b.cardset) AS set_name,
           pe.tier::text AS tier, b.sport,
           public.panini_asset_url(coalesce(pe.thumbnail_url, b.image_url)) AS thumbnail_url,
           (pe.external_id IS NOT NULL) AS catalogued,
           f.fmv_usd, f.confidence::text AS confidence
    FROM base b
    JOIN u ON true
    LEFT JOIN panini_editions pe ON pe.external_id = coalesce(b.edition_external_id, b.psku)
    LEFT JOIN editions e
      ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND e.external_id = coalesce(b.edition_external_id, b.psku)
    LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
    WHERE NOT b.moved
  )
  SELECT jsonb_build_object(
    'username', (SELECT username FROM u),
    'walk', (SELECT jsonb_build_object(
               'last_walk_at', last_walk_at, 'last_complete_at', last_complete_at,
               'profile_state', profile_state, 'reported_total', reported_total,
               'cards_collected', cards_collected, 'unopened_packs', unopened_packs,
               'last_error', last_error) FROM walk),
    'cards_held',       (SELECT count(*) FROM held),
    'cards_moved_since_seen', (SELECT count(*) FROM base WHERE moved),
    'editions',         (SELECT count(DISTINCT psku) FROM held),
    'catalogued_cards', (SELECT count(*) FROM held WHERE catalogued),
    'special_serials',  (SELECT count(*) FROM held WHERE is_special),
    'listed_now',       (SELECT count(*) FROM held WHERE is_listed IS TRUE),
    'fmv_held_usd',     (SELECT round(sum(fmv_usd), 2) FROM held WHERE fmv_usd > 0),
    'fmv_priced_cards', (SELECT count(*) FROM held WHERE fmv_usd > 0),
    'cards', COALESCE((
      SELECT jsonb_agg(to_jsonb(c.*) ORDER BY c.fmv_usd DESC NULLS LAST, c.sku)
      FROM (
        SELECT url_key AS sku, psku AS edition_external_id, serial_number, mint_cap,
               coalesce(is_listed, false) AS is_listed, price_usd AS ask_usd,
               NULL::numeric AS last_sale_usd, NULL::timestamptz AS last_sale_at,
               last_seen_at AS captured_at, is_number_one, is_jersey_mint, is_perfect_mint,
               player_name, set_name, tier, sport, catalogued, thumbnail_url, fmv_usd, confidence
        FROM held
        ORDER BY fmv_usd DESC NULLS LAST, url_key
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
      ) c
    ), '[]'::jsonb)
  )
$$;
