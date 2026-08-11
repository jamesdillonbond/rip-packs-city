-- FIX: 91 Golazos moment pages emitted team links that 404'd.
-- `lib/moment-detail-format.ts:slugifyTeam` strips diacritics (NFKD) before
-- slugifying, so the page links /laliga-golazos/team/atletico-de-madrid, while
-- this resolver only matched the raw SQL expression 'atl-tico-de-madrid'.
-- Affected: Atletico de Madrid (51 editions), UD Almeria (16), Cadiz CF (13),
-- Malaga CF, Deportivo de la Coruna, CD Leganes, Hercules CF.
--
-- Trevor's ruling: accept EITHER slug. So the exact-match fast path is left
-- untouched (it is what the functional index idx_editions_collection_team_slug
-- serves, and a bare OR would defeat that index and reintroduce the documented
-- cold-scan -> connection-pool-timeout class). The unaccent lane runs ONLY when
-- the fast path found nothing, i.e. on a would-be 404.
DO $mig$
DECLARE
  src text;
  out_src text;
  n int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO src FROM pg_proc WHERE proname = 'get_team_detail';
  IF src IS NULL THEN RAISE EXCEPTION 'get_team_detail not found'; END IF;

  out_src := src;

  -- Pinnacle branch (franchise)
  out_src := replace(out_src,
    E'      AND regexp_replace(lower(trim(franchise)), \'[^a-z0-9]+\', \'-\', \'g\') = p_team_slug;\n\n    IF v_team_variants IS NULL THEN RETURN NULL; END IF;',
    E'      AND regexp_replace(lower(trim(franchise)), \'[^a-z0-9]+\', \'-\', \'g\') = p_team_slug;\n\n    -- Fallback: accept the diacritic-stripped slug the frontend emits.\n    IF v_team_variants IS NULL THEN\n      SELECT array_agg(DISTINCT franchise),\n             (array_agg(franchise ORDER BY franchise))[1]\n      INTO v_team_variants, v_team_canonical\n      FROM pinnacle_editions\n      WHERE franchise IS NOT NULL\n        AND regexp_replace(lower(trim(extensions.unaccent(franchise))), \'[^a-z0-9]+\', \'-\', \'g\') = p_team_slug;\n    END IF;\n\n    IF v_team_variants IS NULL THEN RETURN NULL; END IF;');

  -- Flow branch (team_name)
  out_src := replace(out_src,
    E'      AND regexp_replace(lower(trim(team_name)), \'[^a-z0-9]+\', \'-\', \'g\') = p_team_slug;\n\n    IF v_team_variants IS NULL THEN RETURN NULL; END IF;',
    E'      AND regexp_replace(lower(trim(team_name)), \'[^a-z0-9]+\', \'-\', \'g\') = p_team_slug;\n\n    -- Fallback: accept the diacritic-stripped slug the frontend emits\n    -- (e.g. atletico-de-madrid for "Atletico de Madrid"). Runs only on a\n    -- would-be 404, so the functional index still serves the hot path.\n    IF v_team_variants IS NULL THEN\n      SELECT array_agg(DISTINCT team_name),\n             (array_agg(team_name ORDER BY team_name))[1]\n      INTO v_team_variants, v_team_canonical\n      FROM editions\n      WHERE collection_id = p_collection_id\n        AND team_name IS NOT NULL\n        AND regexp_replace(lower(trim(extensions.unaccent(team_name))), \'[^a-z0-9]+\', \'-\', \'g\') = p_team_slug;\n    END IF;\n\n    IF v_team_variants IS NULL THEN RETURN NULL; END IF;');

  -- Guard: both arms must have matched, else abort rather than silently no-op.
  n := (length(out_src) - length(src));
  IF n <= 0 THEN
    RAISE EXCEPTION 'get_team_detail patch did not match (whitespace drift?) — aborting, nothing changed';
  END IF;
  IF (length(out_src) - length(replace(out_src, 'extensions.unaccent', ''))) / length('extensions.unaccent') <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 unaccent fallbacks, got a different count — aborting';
  END IF;

  EXECUTE out_src;
END
$mig$;