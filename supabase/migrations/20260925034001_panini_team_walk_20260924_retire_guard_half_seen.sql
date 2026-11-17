-- Panini team walk — the retirement step refuses a walk that saw < 50 % of a team's
-- active listings (2026-09-24). Found while dry-running the rotation: Panini answered
-- page 1 for the Hawks and the Jazz with an EMPTY list, then 30 listings minutes later.
-- An empty page is the walker's only end-of-list signal, so that answer would have
-- "completed" the walk and retired every active listing for the team. The walker now
-- re-reads an empty page before believing it; this is the independent second net.
--
-- CREATE OR REPLACE of panini_team_listings_ingest — body taken from the live prosrc
-- (md5 7dec5ade…, identical to 20260924141618's file) with only the retirement step
-- changed; same signature, same SECURITY INVOKER + search_path, ACL unchanged.
-- anon-exec: intentional — CREATE OR REPLACE keeps the live ACL (service_role only) (panini_team_listings_ingest)
--
-- Revert: re-run the panini_team_listings_ingest definition from
-- 20260924141618_panini_team_walk_20260924_staging_aliases_and_ingest.sql.

CREATE OR REPLACE FUNCTION public.panini_team_listings_ingest(
  p_sport text, p_team_raw text, p_walk_started_at timestamptz, p_rows jsonb, p_complete boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_written int := 0;
  v_mapped int := 0;
  v_unmapped int := 0;
  v_retired int := 0;
  v_seen int := 0;
  v_active int := 0;
  v_retire_skipped boolean := false;
BEGIN
  IF p_sport NOT IN ('Basketball','Baseball') THEN
    RAISE EXCEPTION 'panini_team_listings_ingest: unsupported sport %', p_sport;
  END IF;
  IF coalesce(btrim(p_team_raw), '') = '' OR p_walk_started_at IS NULL THEN
    RAISE EXCEPTION 'panini_team_listings_ingest: team and walk start are required';
  END IF;

  WITH src AS (
    SELECT DISTINCT ON (r->>'sku')
           r->>'sku' AS sku, r->>'psku' AS psku, nullif(r->>'team', '') AS team,
           r->>'athlete' AS athlete, r->>'cardset' AS cardset,
           CASE WHEN r->>'genesis_year' ~ '^\d{4}$' THEN (r->>'genesis_year')::int END AS genesis_year,
           r->>'rarity' AS rarity,
           CASE WHEN r->>'end_seq' ~ '^\d+$' THEN (r->>'end_seq')::int END AS end_seq,
           CASE WHEN r->>'price_usd' ~ '^\d+(\.\d+)?$' THEN (r->>'price_usd')::numeric END AS price_usd,
           r->>'nft_type' AS nft_type
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) AS r
    WHERE coalesce(r->>'sku', '') <> '' AND coalesce(r->>'psku', '') <> ''
    ORDER BY r->>'sku'
  ), up AS (
    INSERT INTO panini_team_listings AS t
      (sku, psku, sport, walk_team, team_raw, franchise_keys, unmapped_teams, athlete, cardset,
       set_id, genesis_year, rarity, end_seq, price_usd, nft_type, active, first_seen_at, last_seen_at, retired_at)
    SELECT s.sku, s.psku, p_sport, p_team_raw, s.team, m.keys, m.unmapped, s.athlete, s.cardset,
           split_part(s.psku, '_', 1), s.genesis_year, s.rarity, s.end_seq, s.price_usd, s.nft_type,
           true, now(), now(), NULL
    FROM src s
    CROSS JOIN LATERAL panini_resolve_team_keys(p_sport, s.team) m
    ON CONFLICT (sku) DO UPDATE SET
      psku = EXCLUDED.psku, sport = EXCLUDED.sport, walk_team = EXCLUDED.walk_team,
      team_raw = EXCLUDED.team_raw, franchise_keys = EXCLUDED.franchise_keys,
      unmapped_teams = EXCLUDED.unmapped_teams, athlete = EXCLUDED.athlete, cardset = EXCLUDED.cardset,
      set_id = EXCLUDED.set_id, genesis_year = EXCLUDED.genesis_year, rarity = EXCLUDED.rarity,
      end_seq = EXCLUDED.end_seq, price_usd = EXCLUDED.price_usd, nft_type = EXCLUDED.nft_type,
      active = true, last_seen_at = now(), retired_at = NULL
    RETURNING cardinality(t.franchise_keys) > 0 AS is_mapped
  )
  SELECT count(*), count(*) FILTER (WHERE is_mapped), count(*) FILTER (WHERE NOT is_mapped)
    INTO v_written, v_mapped, v_unmapped
  FROM up;

  -- A listing this complete walk did not see is no longer listed. Scoped to the same
  -- (sport, walk_team), and never on a partial walk (the caller passes p_complete only
  -- when the grid ended in an empty page AND every earlier flush landed).
  --
  -- ⚠ AND NEVER WHEN THE WALK SAW LESS THAN HALF OF WHAT IS ACTIVE. The end-of-list
  -- signal is an empty page, and Panini has answered a live team's page 1 with an
  -- empty list (Hawks + Jazz, 2026-09-24, 30 listings each minutes later). The walker
  -- now re-reads an empty page before believing it; this is the second, independent
  -- net: a "complete" walk that saw < 50 % of the team's active listings retires
  -- nothing and says so (retire_skipped), and the walker reports the run ok=false.
  IF p_complete THEN
    SELECT count(*) FILTER (WHERE last_seen_at >= p_walk_started_at), count(*)
      INTO v_seen, v_active
      FROM panini_team_listings
     WHERE sport = p_sport AND walk_team = p_team_raw AND active;
    IF v_active > 0 AND v_seen * 2 < v_active THEN
      v_retire_skipped := true;
    ELSE
      UPDATE panini_team_listings
         SET active = false, retired_at = now()
       WHERE sport = p_sport AND walk_team = p_team_raw AND active
         AND last_seen_at < p_walk_started_at;
      GET DIAGNOSTICS v_retired = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object('written', v_written, 'mapped', v_mapped, 'unmapped', v_unmapped, 'retired', v_retired,
                            'retire_skipped', v_retire_skipped, 'seen', v_seen, 'active_before', v_active);
END;
$function$;