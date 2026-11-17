-- audit_20260928_trophy_picker_offers_linked_panini_cards
--
-- Trevor 2026-09-28: "Are we able to choose panini for trophy case?" — no, and then "Do it all".
--
-- WHY IT COULD NOT. The trophy picker reads get_user_top_owned_moments, which reads
-- wallet_moments_cache joined to saved_wallets. A Panini owner is a USERNAME, not an address,
-- linked in saved_collector_identities (migration 20260925233206) — so wallet_moments_cache holds
-- 0 Panini rows (measured 2026-09-28) and the picker hid the chip rather than show an empty list
-- that would read as "you own none".
--
-- WHAT THIS ADDS. A second branch, UNION ALL'd beside the unchanged wallet branch, over the Panini
-- usernames THIS user linked:
--   (a) panini_user_holdings — the cards read off the username's PUBLIC Panini profile by the
--       collector walk (the whole collection, as of that walk). Linked usernames are walked by
--       the panini-collector-walk cron.
--   (b) panini_card_serials rows whose owner is that username, captured AFTER the last complete
--       walk (or with no complete walk yet) and not already in (a) — so a card bought since the
--       walk, or a username not yet walked, is still offered. A serial captured BEFORE the last
--       complete walk and absent from it was sold; it is NOT offered.
--   BURNT serials are excluded from both.
--
-- HONESTY, per branch column:
--   · wallet_address is NULL for Panini rows: a username is not an address, and every
--     chain-aware wallet helper downstream would treat it as one (lib/profile/collector-identities.ts).
--   · fmv_usd is the edition's latest fmv_snapshots row — the SAME read get_trophy_slab_data
--     renders, so the picker and the pinned slab agree. An uncatalogued card has NULL, never 0,
--     and the picker says "FMV unknown". The wallet branch keeps its fmv > 0 filter unchanged;
--     the Panini branch does NOT filter on FMV: 146 of 146 walked cards (2026-09-28) are outside
--     the catalogued editions, so an fmv filter would offer nothing.
--   · league is NULL, so an explicit NBA/WNBA league filter excludes Panini (as it does Pinnacle).
--
-- ORDER: fmv DESC NULLS LAST as before, then serial ASC and moment_id as a deterministic tiebreak
-- (unpriced Panini rows would otherwise tie).
--
-- COST: panini_names is empty for every user who has linked no Panini username, so the branch
-- does one indexed read of saved_collector_identities (idx_saved_collector_identities_user) and
-- stops. The owner read uses idx_panini_serials_owner_lower.
--
-- anon-exec: unchanged (get_user_top_owned_moments) — CREATE OR REPLACE keeps the existing ACL (service_role only since
-- 20260731213000).
--
-- REVERT: re-run the CREATE OR REPLACE body in
--   supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql

CREATE OR REPLACE FUNCTION public.get_user_top_owned_moments(p_user_id uuid, p_limit integer DEFAULT 24, p_league text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, character_name text, edition_name text, league text, serial_fmv jsonb, team_name text, jersey_number integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH user_wallets AS (
    SELECT DISTINCT wallet_addr FROM saved_wallets WHERE user_id = p_user_id
  ),
  filtered AS (
    SELECT wmc.*
    FROM wallet_moments_cache wmc
    JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
    WHERE wmc.fmv_usd IS NOT NULL AND wmc.fmv_usd > 0
      AND (p_league IS NULL OR wmc.league = p_league)
      AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
  ),
  ranked AS (
    SELECT
      f.*,
      ROW_NUMBER() OVER (
        PARTITION BY f.moment_id, f.collection_id
        ORDER BY f.fmv_usd DESC NULLS LAST, f.last_seen_at DESC
      ) AS rn
    FROM filtered f
  ),
  wallet_rows AS (
    SELECT
      r.moment_id AS o_moment_id, r.collection_id AS o_collection_id, c.slug::TEXT AS o_collection_slug,
      r.wallet_address AS o_wallet_address,
      r.player_name AS o_player_name, r.set_name AS o_set_name, r.tier AS o_tier,
      r.serial_number AS o_serial_number, r.mint_count AS o_mint_count,
      r.fmv_usd AS o_fmv_usd,
      COALESCE(
        r.image_url,
        e.thumbnail_url,
        NULLIF(pe.thumbnail_url, 'https://assets.disneypinnacle.com/on-chain/pinnacle.jpg'),
        CASE
          WHEN c.slug = 'nba_top_shot' THEN
            'https://assets.nbatopshot.com/media/' || r.moment_id || '/image?width=512'
          ELSE NULL
        END
      ) AS o_image_url,
      r.is_locked AS o_is_locked, r.series_number AS o_series_number, r.edition_key AS o_edition_key,
      r.character_name AS o_character_name, r.edition_name AS o_edition_name, r.league AS o_league,
      public.serial_fmv_estimate(r.collection_id, r.serial_number, r.mint_count, r.tier, sf.fmv_usd, sf.confidence::text, e.id) AS o_serial_fmv,
      e.team_name AS o_team_name,
      e.jersey_number::integer AS o_jersey_number
    FROM ranked r
    LEFT JOIN collections c ON c.id = r.collection_id
    LEFT JOIN editions e
      ON e.collection_id = r.collection_id
     AND e.external_id = r.edition_key
    LEFT JOIN pinnacle_editions pe
      ON c.slug = 'disney_pinnacle'
     AND pe.edition_key = r.edition_key
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) sf ON true
    WHERE r.rn = 1
  ),
  panini_names AS (
    SELECT DISTINCT sci.identity_value AS username
    FROM saved_collector_identities sci
    WHERE sci.user_id = p_user_id
      AND sci.collection_id = v_panini
      AND sci.identity_kind = 'username'
      AND p_league IS NULL
      AND (p_collection_id IS NULL OR p_collection_id = v_panini)
  ),
  panini_seen AS (
    -- (a) the walked public profile
    SELECT h.url_key AS sku, COALESCE(s.edition_external_id, h.psku) AS ed_key,
           COALESCE(h.serial_number, s.serial_number) AS serial, COALESCE(h.mint_cap, s.mint_cap) AS cap,
           h.athlete, h.cardset, h.image_url AS img, h.last_seen_at AS seen_at
    FROM panini_names pn
    JOIN panini_user_holdings h ON h.username = pn.username
    LEFT JOIN panini_card_serials s ON s.sku = h.url_key
    WHERE COALESCE(s.serial_state, '') <> 'BURNT'
    UNION ALL
    -- (b) serials seen under the username since its last complete walk
    SELECT s.sku, s.edition_external_id, s.serial_number, s.mint_cap,
           NULL::text, NULL::text, NULL::text, s.captured_at
    FROM panini_names pn
    JOIN panini_card_serials s ON s.owner <> '' AND lower(s.owner) = pn.username
    LEFT JOIN panini_collector_walks w ON w.username = pn.username
    WHERE COALESCE(s.serial_state, '') <> 'BURNT'
      AND (w.last_complete_at IS NULL OR s.captured_at > w.last_complete_at)
      AND NOT EXISTS (
        SELECT 1 FROM panini_user_holdings h2
        WHERE h2.username = pn.username AND h2.url_key = s.sku
      )
  ),
  panini_dedup AS (
    SELECT DISTINCT ON (ps.sku) ps.*
    FROM panini_seen ps
    ORDER BY ps.sku, ps.seen_at DESC NULLS LAST
  ),
  panini_rows AS (
    SELECT
      d.sku AS o_moment_id, v_panini AS o_collection_id, c.slug::TEXT AS o_collection_slug,
      NULL::text AS o_wallet_address,
      COALESCE(e.player_name, pe.player_name, d.athlete) AS o_player_name,
      COALESCE(e.set_name, pe.set_name, d.cardset) AS o_set_name,
      COALESCE(e.tier::text, pe.tier::text) AS o_tier,
      d.serial AS o_serial_number,
      COALESCE(d.cap, e.circulation_count) AS o_mint_count,
      sf.fmv_usd AS o_fmv_usd,
      COALESCE(public.panini_asset_url(d.img), e.thumbnail_url, public.panini_asset_url(pe.thumbnail_url)) AS o_image_url,
      false AS o_is_locked, NULL::integer AS o_series_number, d.ed_key AS o_edition_key,
      NULL::text AS o_character_name, NULL::text AS o_edition_name, NULL::text AS o_league,
      public.serial_fmv_estimate(v_panini, d.serial, COALESCE(d.cap, e.circulation_count), e.tier::text, sf.fmv_usd, sf.confidence::text, e.id) AS o_serial_fmv,
      e.team_name AS o_team_name,
      e.jersey_number::integer AS o_jersey_number
    FROM panini_dedup d
    LEFT JOIN collections c ON c.id = v_panini
    LEFT JOIN editions e
      ON e.collection_id = v_panini
     AND e.external_id = d.ed_key
    LEFT JOIN panini_editions pe ON pe.external_id = d.ed_key
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) sf ON true
  ),
  all_rows AS (
    SELECT * FROM wallet_rows
    UNION ALL
    SELECT * FROM panini_rows
  )
  SELECT
    a.o_moment_id, a.o_collection_id, a.o_collection_slug, a.o_wallet_address,
    a.o_player_name, a.o_set_name, a.o_tier, a.o_serial_number, a.o_mint_count,
    a.o_fmv_usd, a.o_image_url, a.o_is_locked, a.o_series_number, a.o_edition_key,
    a.o_character_name, a.o_edition_name, a.o_league, a.o_serial_fmv,
    a.o_team_name, a.o_jersey_number
  FROM all_rows a
  ORDER BY a.o_fmv_usd DESC NULLS LAST, a.o_serial_number ASC NULLS LAST, a.o_moment_id
  LIMIT p_limit;
END;
$function$;
