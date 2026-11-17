-- audit_20261109_trophy_picker_panini_holdings_named_before_serial_lookup
--
-- #243 (2026-11-09, Claude Code, Trevor's laptop): the trophy picker's Panini search could
-- still exceed its 8 s budget COLD for a big profile. Measured on rigged (linked timdunkin,
-- 6,023 cards), "Damian Lillard", the Panini branch as literal SQL: 16.1 s, 88k buffers
-- (11,969 read); 14.0 s of it the per-card panini_card_serials index probe (6,023 loops,
-- 10,443 blocks read) — run for every held card before the word filter kept 79.
--
-- Change (Panini branch only): a MATERIALIZED panini_held CTE matches the words on each
-- holding's OWN psku edition (editions / panini_editions joins, + athlete / cardset), and the
-- panini_card_serials lookup runs only for what survives. Equivalence: over all 43,182
-- holdings psku is never NULL and panini_card_serials.edition_external_id never differs from
-- it (0 rows, 11-09), so the pre-filter keys on the same edition the final filter does; the
-- final filter in panini_named is unchanged. Branch (b) (serials seen under the username,
-- not in holdings) is unchanged. No query (v_words NULL) = no pre-filter, same rows.
--
-- Also re-states SET plan_cache_mode = force_custom_plan (20261109051044) — CREATE OR
-- REPLACE resets a function's SET options, so leaving it out would silently drop it.
--
-- anon-exec: NOT granted (get_user_top_owned_moments) — reached only through the service-role route app/api/profile/top-moments; EXECUTE revoked from PUBLIC, anon, authenticated below.
--
-- Revert: re-apply the function in
-- 20261109050827_audit_20261108_trophy_picker_panini_name_filter_first.sql, then
-- ALTER FUNCTION public.get_user_top_owned_moments(uuid, integer, text, uuid, text, integer) SET plan_cache_mode = force_custom_plan;

CREATE OR REPLACE FUNCTION public.get_user_top_owned_moments(p_user_id uuid, p_limit integer DEFAULT 24, p_league text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid, p_query text DEFAULT NULL::text, p_offset integer DEFAULT 0)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, character_name text, edition_name text, league text, serial_fmv jsonb, team_name text, jersey_number integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  -- A typed query is split into WORDS; EVERY word must appear (case-insensitive
  -- substring) somewhere in the row's searchable fields, in any field — so
  -- "Damian Lillard Extra Spice" finds the Lillard whose SET is Extra Spice
  -- (2026-11-08). % and _ in the input are literal characters, never wildcards.
  -- NULL / blank = no name filter.
  v_words text[] := CASE
    WHEN p_query IS NULL OR btrim(p_query) = '' THEN NULL
    ELSE ARRAY(
      SELECT '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      FROM regexp_split_to_table(btrim(p_query), '\s+') AS w
    )
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
      AND (v_words IS NULL
           OR concat_ws(' ', r.player_name, r.set_name, e.team_name, r.character_name, r.edition_name) ILIKE ALL (v_words))
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
  -- HOLDINGS NAMED FIRST (2026-11-09, #243): a held card's edition is its own psku
  -- (measured over all 43,182 holdings: psku never NULL, and panini_card_serials'
  -- edition_external_id never differs from it), so the words are matched on the
  -- psku's edition joins BEFORE the per-card panini_card_serials lookup — the
  -- cold cost of a big profile (6,023 index probes into a 9.3 GB table, ~10k
  -- blocks, ~14 s of rigged's 16 s "Damian Lillard" read). panini_named still
  -- applies the same filter on the final key, so a survivor's row is unchanged.
  panini_held AS MATERIALIZED (
    SELECT h.*
    FROM panini_names pn
    JOIN panini_user_holdings h ON h.username = pn.username
    LEFT JOIN editions e0
      ON e0.collection_id = v_panini
     AND e0.external_id = h.psku
    LEFT JOIN panini_editions pe0 ON pe0.external_id = h.psku
    WHERE (v_words IS NULL
           OR concat_ws(' ', COALESCE(e0.player_name, pe0.player_name, h.athlete),
                             COALESCE(e0.set_name, pe0.set_name, h.cardset),
                             e0.team_name) ILIKE ALL (v_words))
  ),
  panini_seen AS (
    -- (a) the walked public profile
    SELECT h.url_key AS sku, COALESCE(s.edition_external_id, h.psku) AS ed_key,
           COALESCE(h.serial_number, s.serial_number) AS serial, COALESCE(h.mint_cap, s.mint_cap) AS cap,
           h.athlete, h.cardset, h.image_url AS img, h.last_seen_at AS seen_at
    FROM panini_held h
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
  -- NAME FILTER FIRST (2026-11-08, Dame Time): the words are matched on the
  -- cheap edition joins BEFORE the per-card latest-FMV lateral and
  -- serial_fmv_estimate run. Filtering after them made a 6,023-card Panini
  -- profile (rigged) run 22-31 s for "Damian Lillard" -- past the route's 8 s
  -- read budget and this function's own 8 s statement_timeout -- so the picker
  -- answered "Couldn't load your Moments". MATERIALIZED keeps the filter from
  -- being planned after the lateral again.
  panini_named AS MATERIALIZED (
    SELECT
      d.sku, d.ed_key, d.serial, d.cap, d.img,
      e.id AS e_id, e.tier::text AS e_tier, e.circulation_count AS e_circ,
      e.thumbnail_url AS e_thumb, e.team_name AS e_team, e.jersey_number AS e_jersey,
      COALESCE(e.player_name, pe.player_name, d.athlete) AS n_player,
      COALESCE(e.set_name, pe.set_name, d.cardset) AS n_set,
      COALESCE(e.tier::text, pe.tier::text) AS n_tier,
      pe.thumbnail_url AS pe_thumb
    FROM panini_dedup d
    LEFT JOIN editions e
      ON e.collection_id = v_panini
     AND e.external_id = d.ed_key
    LEFT JOIN panini_editions pe ON pe.external_id = d.ed_key
    WHERE (v_words IS NULL
           OR concat_ws(' ', COALESCE(e.player_name, pe.player_name, d.athlete),
                             COALESCE(e.set_name, pe.set_name, d.cardset),
                             e.team_name) ILIKE ALL (v_words))
  ),
  panini_rows AS (
    SELECT
      n.sku AS o_moment_id, v_panini AS o_collection_id, c.slug::TEXT AS o_collection_slug,
      NULL::text AS o_wallet_address,
      n.n_player AS o_player_name,
      n.n_set AS o_set_name,
      n.n_tier AS o_tier,
      n.serial AS o_serial_number,
      COALESCE(n.cap, n.e_circ) AS o_mint_count,
      sf.fmv_usd AS o_fmv_usd,
      COALESCE(public.panini_asset_url(n.img), n.e_thumb, public.panini_asset_url(n.pe_thumb)) AS o_image_url,
      false AS o_is_locked, NULL::integer AS o_series_number, n.ed_key AS o_edition_key,
      NULL::text AS o_character_name, NULL::text AS o_edition_name, NULL::text AS o_league,
      public.serial_fmv_estimate(v_panini, n.serial, COALESCE(n.cap, n.e_circ), n.e_tier, sf.fmv_usd, sf.confidence::text, n.e_id) AS o_serial_fmv,
      n.e_team AS o_team_name,
      n.e_jersey::integer AS o_jersey_number
    FROM panini_named n
    LEFT JOIN collections c ON c.id = v_panini
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = n.e_id
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
  -- collection_id breaks the last tie: a moment_id is unique only WITHIN a
  -- collection, and "Load more" pages with OFFSET, so the order must be total
  -- or a row can repeat on one page and vanish from the next (2026-11-08).
  ORDER BY a.o_fmv_usd DESC NULLS LAST, a.o_serial_number ASC NULLS LAST, a.o_moment_id, a.o_collection_id
  LIMIT p_limit
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_user_top_owned_moments(uuid, integer, text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
