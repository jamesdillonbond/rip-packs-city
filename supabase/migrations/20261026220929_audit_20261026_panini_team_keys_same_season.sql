-- audit_20261026: the Panini team map gains a same-SEASON inference — the same player's directly evidenced cards in
-- OTHER products of the same sport and season (Football and Baseball only). NFL had 7,423 of 11,006 catalogued cards
-- on no team (10-26): the walk reaches ~5 teams a night and NFL cards print no team. Measured 10-26 before shipping:
--   · held out (each walk-placed card predicted from the other same-season products only, unanimous):
--     NFL 1,411 / 1,418 correct (99.5 %), MLB 73 / 74 (98.6 %); NBA 7,251 / 7,511 (96.5 %, trades + mixed
--     "2021" / "2021-22" labels) and WNBA (no held-out set) are NOT included;
--   · gain: NFL +1,362, MLB +56 cards (22 NFL cards have conflicting evidence and stay none).
-- Rules: only when the card's own product holds no evidence for the player (never overrides a same-product sibling
-- or conflict); evidence is listing / printed with exactly one team (never another inference); never a two-player
-- card ("A | B"). Recorded as source 'sibling' + new column basis = 'same_season' (same-product siblings get basis
-- 'same_product'): the source CHECK constraint allows only listing / printed / sibling / none, and widening it would
-- mean dropping it. Everything else is unchanged from 20261026044548.
-- Revert: re-apply the function body from 20261026044548 (the next hourly run returns the season rows to none), then
--         UPDATE public.panini_edition_team_keys SET basis = NULL; (that body does not write basis, so it would go stale).
-- anon-exec: unchanged — refresh_panini_edition_team_keys stays revoked from PUBLIC, anon, authenticated (20261026044548).

ALTER TABLE public.panini_edition_team_keys ADD COLUMN IF NOT EXISTS basis text
  CHECK (basis IS NULL OR basis IN ('same_product', 'same_season'));
COMMENT ON COLUMN public.panini_edition_team_keys.basis IS
  'For source sibling: which cards decided the team — same_product (the same player in the same product) or same_season (the same player in other products of the same sport and season; Football / Baseball only). NULL otherwise. audit_20261026.';

CREATE OR REPLACE FUNCTION public.refresh_panini_edition_team_keys()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
  v_mapped  integer := 0;
BEGIN
  WITH cat AS MATERIALIZED (
    SELECT pe.external_id, pp.last_grid_sport AS sport, pe.product_set_id,
           nullif(btrim(pe.player_name), '') AS player_name,
           nullif(btrim(pe.nation), '')      AS printed_team,
           substring(pp.name FROM '(?:19|20)[0-9]{2}')::int AS name_year,
           -- the product's season label ("2024", "2021-22") for the same-season rule (audit_20261026)
           substring(pp.name FROM '^((?:19|20)[0-9]{2}(?:-[0-9]{2})?)') AS season
      FROM public.panini_editions pe
      JOIN public.panini_products pp ON pp.set_id = pe.product_set_id
     WHERE pp.last_grid_sport IN ('Basketball', 'Baseball', 'Football', 'Womens Basketball')
  ), lk AS MATERIALIZED (
    SELECT l.psku AS external_id, array_agg(DISTINCT k ORDER BY k) AS keys
      FROM public.panini_team_listings l
     CROSS JOIN LATERAL unnest(l.franchise_keys) k
     GROUP BY l.psku
  ), yr AS MATERIALIZED (
    -- a card's year for MLB shared-city resolution: the walk's genesis_year for the product, else the product name's year
    SELECT l.set_id, max(l.genesis_year)::int AS y
      FROM public.panini_team_listings l
     WHERE l.genesis_year IS NOT NULL
     GROUP BY l.set_id
  ), c2 AS MATERIALIZED (
    SELECT c.*,
           CASE WHEN c.sport = 'Baseball' THEN c.player_name END                 AS athlete,
           CASE WHEN c.sport = 'Baseball' THEN coalesce(yr.y, c.name_year) END   AS y
      FROM cat c LEFT JOIN yr ON yr.set_id = c.product_set_id::text
  ), pt AS MATERIALIZED (
    SELECT d.sport, d.printed_team, d.athlete, d.y, r.keys
      FROM (SELECT DISTINCT sport, printed_team, athlete, y FROM c2 WHERE printed_team IS NOT NULL) d
     CROSS JOIN LATERAL public.panini_resolve_team_keys_for(d.sport, d.printed_team, d.athlete, d.y) r
  ), own AS MATERIALIZED (
    SELECT c.external_id, c.sport, c.product_set_id, c.player_name, c.season,
           CASE WHEN cardinality(lk.keys) > 0 THEN lk.keys WHEN cardinality(pt.keys) > 0 THEN pt.keys END AS keys,
           CASE WHEN cardinality(lk.keys) > 0 THEN 'listing' WHEN cardinality(pt.keys) > 0 THEN 'printed' END AS source
      FROM c2 c
      LEFT JOIN lk ON lk.external_id = c.external_id
      LEFT JOIN pt ON pt.sport = c.sport AND pt.printed_team = c.printed_team
                  AND pt.athlete IS NOT DISTINCT FROM c.athlete AND pt.y IS NOT DISTINCT FROM c.y
  ), grp AS MATERIALIZED (
    SELECT product_set_id, player_name, min(keys::text) AS k, count(DISTINCT keys::text) AS nk
      FROM own
     WHERE keys IS NOT NULL AND player_name IS NOT NULL AND product_set_id IS NOT NULL
     GROUP BY 1, 2
  ), sea AS MATERIALIZED (
    -- audit_20261026: the same player's DIRECTLY evidenced (listing / printed, one team) cards in the same sport and
    -- SEASON. Football and Baseball only (held out 10-26: NFL 1,411 / 1,418 = 99.5 %, MLB 73 / 74; NBA 96.5 % —
    -- trades and mixed season labels — and WNBA untestable, so not used). Never a two-player card.
    SELECT o.sport, o.season, o.player_name, min(o.keys[1]) AS k, count(DISTINCT o.keys[1]) AS nk
      FROM own o
     WHERE o.source IN ('listing', 'printed') AND cardinality(o.keys) = 1
       AND o.sport IN ('Football', 'Baseball') AND o.season IS NOT NULL
       AND o.player_name IS NOT NULL AND o.player_name NOT LIKE '%|%'
     GROUP BY 1, 2, 3
  ), want AS (
    -- Priority: listing > printed > unanimous same-product sibling > unanimous same-season other product > none.
    -- The season rule applies only when the card's OWN product has no evidence for the player (g IS NULL), so its
    -- evidence is necessarily from other products, and a same-product conflict is never overridden.
    -- A season placement is source 'sibling' (the same player's other evidenced cards) with basis 'same_season';
    -- a same-product one keeps basis 'same_product'. basis is NULL for listing / printed / none.
    SELECT o.external_id, o.sport,
           coalesce(o.keys, CASE WHEN g.nk = 1 THEN g.k::text[] END,
                    CASE WHEN g.product_set_id IS NULL AND s.nk = 1 THEN ARRAY[s.k] END, '{}'::text[]) AS keys,
           coalesce(o.source, CASE WHEN g.nk = 1 THEN 'sibling' END,
                    CASE WHEN g.product_set_id IS NULL AND s.nk = 1 THEN 'sibling' END, 'none')       AS source,
           CASE WHEN o.keys IS NOT NULL THEN NULL
                WHEN g.nk = 1 THEN 'same_product'
                WHEN g.product_set_id IS NULL AND s.nk = 1 THEN 'same_season' END                  AS basis
      FROM own o
      LEFT JOIN grp g ON g.product_set_id = o.product_set_id AND g.player_name = o.player_name
      LEFT JOIN sea s ON s.sport = o.sport AND s.season = o.season AND s.player_name = o.player_name
  )
  INSERT INTO public.panini_edition_team_keys AS t (external_id, sport, franchise_keys, source, basis, computed_at)
  SELECT external_id, sport, keys, source, basis, v_started FROM want
  ON CONFLICT (external_id) DO UPDATE SET
    sport = EXCLUDED.sport, franchise_keys = EXCLUDED.franchise_keys,
    source = EXCLUDED.source, basis = EXCLUDED.basis, computed_at = EXCLUDED.computed_at
  WHERE (t.sport, t.franchise_keys, t.source, t.basis) IS DISTINCT FROM (EXCLUDED.sport, EXCLUDED.franchise_keys, EXCLUDED.source, EXCLUDED.basis);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(*) INTO v_mapped FROM public.panini_edition_team_keys WHERE cardinality(franchise_keys) > 0;

  PERFORM public.log_pipeline_run('panini-edition-team-keys', v_started, v_mapped, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'changed', v_rows, 'mapped', v_mapped));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-edition-team-keys', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;
