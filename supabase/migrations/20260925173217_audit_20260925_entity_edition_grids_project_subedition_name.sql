-- 2026-09-25 (PT) — the entity edition grids (player / set / series / team /
-- pack contents) name a Top Shot PARALLEL on its tile.
--
-- WHY. /nba-top-shot/player/courtney-lee listed seven tiles that all read
-- "Courtney Lee · Run It Back: For The Win · RARE · Series 2025-26" — the
-- Standard and its six parallels (Blockchain /99, Hardcourt /50, Hexwave /25,
-- Jukebox /10, Galactic /5, Omega /1), distinguishable only by "Mint N".
-- editions.subedition_name carries the name for all 4,732 Top Shot parallel
-- editions (measured 10:35 AM PT); none of the five grid RPCs returned it.
--
-- WHAT. Guarded splice on each live body: `e.subedition_name,` is added
-- after the `e.team_name,` projection of the editions branch (the Pinnacle
-- branch projects from pinnacle_editions and has no such column — it is
-- untouched). Anchor counts asserted per function (get_series_editions has
-- two editions branches). Header (STABLE, SECURITY DEFINER, search_path,
-- statement_timeout) and DEFAULTs reproduced from pg_proc; ACL unchanged
-- (postgres, service_role). None of the five is pinned by
-- db-invariants-drift-guard. Revert: remove the projection by the same splice.

-- anon-exec: intentional — the five grid RPCs stay service_role-only (ACL unchanged by CREATE OR REPLACE: postgres, service_role); they are called by the entity pages with the service client.
DO $$
DECLARE
  r RECORD;
  v_src text;
  v_new text;
  v_n int;
  v_anchor text;
  v_expected int;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname,
           pg_get_function_arguments(p.oid) AS args,
           CASE p.proname WHEN 'get_pack_contents' THEN E'      e.team_name,\n' ELSE E'        e.team_name,\n' END AS anchor,
           CASE p.proname WHEN 'get_series_editions' THEN 2 ELSE 1 END AS expected
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('get_player_editions','get_set_editions','get_series_editions','get_team_top_editions','get_pack_contents')
     ORDER BY p.proname
  LOOP
    v_src := (SELECT prosrc FROM pg_proc WHERE oid = r.oid);
    IF position('e.subedition_name' IN v_src) > 0 THEN
      RAISE NOTICE '%: subedition_name already projected — no-op', r.proname;
      CONTINUE;
    END IF;
    v_anchor := r.anchor;
    v_expected := r.expected;
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> v_expected THEN
      RAISE EXCEPTION '%: expected the e.team_name projection anchor % time(s), found %', r.proname, v_expected, v_n;
    END IF;
    v_new := replace(v_src, v_anchor, v_anchor || replace(v_anchor, 'e.team_name,', 'e.subedition_name,'));
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' SET statement_timeout TO ''8s'' AS %L',
      r.proname, r.args, v_new);
    RAISE NOTICE '%: subedition_name projected (% anchor(s))', r.proname, v_n;
  END LOOP;
END $$;

-- Post-conditions: every function now projects it; a parallel edition of a
-- known Top Shot player names its parallel; a Standard edition reports NULL
-- (no-change control on the shape: the tile prints nothing for it).
DO $$
DECLARE v_missing text; v_rows jsonb; v_named int; v_std int;
BEGIN
  SELECT string_agg(proname, ', ') INTO v_missing FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('get_player_editions','get_set_editions','get_series_editions','get_team_top_editions','get_pack_contents')
     AND position('e.subedition_name' IN prosrc) = 0;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'subedition_name not projected by: %', v_missing; END IF;

  v_rows := public.get_player_editions('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'courtney-lee', 50, 0);
  SELECT count(*) FILTER (WHERE x->>'subedition_name' IS NOT NULL),
         count(*) FILTER (WHERE x->>'subedition_name' IS NULL)
    INTO v_named, v_std
    FROM jsonb_array_elements(v_rows) x;
  IF v_named = 0 THEN RAISE EXCEPTION 'courtney-lee: no parallel edition names its parallel'; END IF;
  IF v_std = 0 THEN RAISE EXCEPTION 'courtney-lee: no Standard edition left with a NULL subedition_name'; END IF;
END $$;
