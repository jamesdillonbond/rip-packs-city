-- audit_20261106_trophy_picker_searches_the_whole_wallet_and_topshot_art_is_the_media_url
--
-- Two defects Trevor hit in the trophy picker on 2026-11-06 (6:35 PM PT, phone),
-- while entering the Dame Time challenge:
--
-- (1) "It's not letting me scroll past these." It was not a scroll bug: the
--     picker loads the 96 highest-value Moments and SEARCHES INSIDE THEM, and he
--     holds exactly six Damian Lillard Moments inside his top 96 (of 15,706).
--     The 10 px disclosure line was true and useless. A typed name must search
--     the WHOLE wallet, server-side: `p_query` (new 5th arg, default NULL =
--     unchanged behaviour) filters player / set / team / character / edition
--     name, case-insensitive, before the fmv ORDER BY + LIMIT, in both the
--     wallet branch and the Panini branch.
--
-- (2) "One of my Dame Cosmics has no thumbnail." Moment 25484's
--     wallet_moments_cache.image_url is a Series-1 edition HERO asset
--     (assets.nbatopshot.com/editions/1_cosmic_legendary/…Hero_2880_2880_Transparent.png)
--     and Dapper has retired that bucket: 12 of 12 random `/editions/1_*` URLs
--     and 4 of the 41 pinned Top Shot trophies answer 404 (the four are all
--     Series 1); every later series still serves. 76,047 held Moments in 194
--     wallets carry the dead shape. DeadImageGuard neutralises the 404 into a
--     blank tile, which is what he saw. The per-Moment media URL
--     (assets.nbatopshot.com/media/<moment_id>/image?width=512) serves for every
--     Top Shot Moment and is what the other eight Top Shot art builders in lib/
--     already use — so for nba_top_shot this function now derives it FIRST and
--     the cached edition hero is never consulted. (It is also 46 KB against a
--     3 MB 2880 px PNG for an 80 px thumbnail.) Other collections keep the
--     ladder unchanged: wmc.image_url → editions.thumbnail_url → pinnacle
--     thumbnail (minus the placeholder).
--
-- The 4-arg overload is DROPPED, not left beside the 5-arg one: PostgREST
-- resolves an rpc() call by argument NAMES, and with `p_query` defaulted both
-- signatures would match a 4-name call (PGRST203 "could not choose the best
-- candidate"). The only caller is app/api/profile/top-moments (service role);
-- its 4-name call binds to the new signature with p_query = NULL. ACL
-- re-asserted after the DROP: service-role-only, as 20260731213000 set it.
--
-- anon-exec: NOT granted (get_user_top_owned_moments) — reached only through the service-role route app/api/profile/top-moments; EXECUTE revoked from PUBLIC, anon, authenticated below, re-asserting 20260731213000 after the DROP.
--
-- Revert: re-apply the 4-arg body from
-- 20260929021709_audit_20260928_trophy_picker_offers_linked_panini_cards.sql
-- (DROP this 5-arg signature first) and re-run the REVOKE.

DROP FUNCTION IF EXISTS public.get_user_top_owned_moments(uuid, integer, text, uuid);

CREATE OR REPLACE FUNCTION public.get_user_top_owned_moments(p_user_id uuid, p_limit integer DEFAULT 24, p_league text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid, p_query text DEFAULT NULL::text)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, character_name text, edition_name text, league text, serial_fmv jsonb, team_name text, jersey_number integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  -- A typed name is a SUBSTRING match, case-insensitive; % and _ in the input
  -- are literal characters, never wildcards. NULL / blank = no name filter.
  v_q text := CASE
    WHEN p_query IS NULL OR btrim(p_query) = '' THEN NULL
    ELSE '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END;
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
      CASE
        -- Top Shot: the per-Moment media URL serves for every Moment; the cached
        -- edition HERO asset is dead for all of Series 1 (2026-11-06).
        WHEN c.slug = 'nba_top_shot' THEN
          'https://assets.nbatopshot.com/media/' || r.moment_id || '/image?width=512'
        ELSE COALESCE(
          r.image_url,
          e.thumbnail_url,
          NULLIF(pe.thumbnail_url, 'https://assets.disneypinnacle.com/on-chain/pinnacle.jpg')
        )
      END AS o_image_url,
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
      AND (v_q IS NULL
           OR r.player_name ILIKE v_q OR r.set_name ILIKE v_q OR e.team_name ILIKE v_q
           OR r.character_name ILIKE v_q OR r.edition_name ILIKE v_q)
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
    WHERE (v_q IS NULL
           OR COALESCE(e.player_name, pe.player_name, d.athlete) ILIKE v_q
           OR COALESCE(e.set_name, pe.set_name, d.cardset) ILIKE v_q
           OR e.team_name ILIKE v_q)
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

REVOKE EXECUTE ON FUNCTION public.get_user_top_owned_moments(uuid, integer, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- Data repair record (run via execute_sql in the same pass, not part of the
-- function change): the dead Series-1 hero URLs were repointed to the media URL
-- in trophy_moments (42 rows) and wallet_moments_cache (76,047 rows); the old
-- values are in public.audit_20261106_topshot_dead_hero_thumbnails_backup
-- (src, row_key, old_url, backed_up_at). RLS is ON and anon/authenticated hold
-- no grant — the smoke suite's check_public_security_invariants read it as
-- rls_off_base_table for one run (03:21Z) before this was set. Re-running this
-- block is a no-op.
ALTER TABLE IF EXISTS public.audit_20261106_topshot_dead_hero_thumbnails_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261106_topshot_dead_hero_thumbnails_backup FROM anon, authenticated;
