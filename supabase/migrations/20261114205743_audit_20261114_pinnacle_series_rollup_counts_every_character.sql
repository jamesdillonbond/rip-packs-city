-- 2026-11-14 (Claude Code cloud, ~1:50 PM PT) — fresh-eyes review of the entity pages.
--
-- get_series_rollups' Disney Pinnacle branch credited each pin to its FIRST character only
-- (`pc.characters[1]`). A pin is tagged with every character on it ("Welcome to Endor":
-- Ewok + Wicket); get_player_detail / get_player_top_sales match ANY element
-- (`unnest(pc.characters)`), so "Top Characters in this Series" disagreed with each
-- character's own page and a character whose pins are all shared could vanish from it.
-- Live: 223 of 2,948 pins carry more than one character (2023 11 · 2024 43 · 2025 77 · 2026 92).
--
-- Splice: the per-pin CTE `ed` keeps feeding the SETS rollup (one row per pin, unchanged); a
-- new CTE `ch` (one row per pin × DISTINCT trimmed character) feeds the CHARACTERS rollup.
-- The other collections' branch is untouched. md5-asserted base 8916f74397ab153be1fec1a5c0263f88;
-- each anchor must occur exactly once. CREATE OR REPLACE via pg_get_functiondef keeps the
-- header, search_path and ACL.
-- anon-exec: unchanged (get_series_rollups) — CREATE OR REPLACE of an existing fn; ACL preserved, read 2026-11-14 ~1:50 PM PT has_function_privilege('anon', …, 'EXECUTE') = false.
-- Read back after apply (20261114205743): md5(prosrc) 37d99a6991cdf1f0af0b64e1df687607, anon EXECUTE false.
-- 2025 Top Characters: Elsa 7 -> 13 pins, Simba (4, every pin shared) now listed; sets total 741 -> 741
-- (no-change control: sets still count each pin once). Top Shot series-2026-27 branch: 12 players, untouched.
--
-- Revert: re-apply supabase/migrations/20261026005855_*series_rollup_players_group_by_person_not_label.sql
-- (the body this splices; its Pinnacle branch is the `characters[1]` form).
DO $$
DECLARE
  v_oid oid := 'public.get_series_rollups(uuid,text)'::regprocedure;
  v_src text;
  v_def text;
  a_old text := E'        regexp_replace(lower(btrim(pc.characters[1])), \'[^a-z0-9]+\', \'-\', \'g\') AS player_slug,\n        btrim(pc.characters[1]) AS player_name,\n        pc.fmv_usd\n      FROM pinnacle_catalog pc\n      WHERE pc.series_name = v_pinnacle_year::text\n    ),';
  a_new text := E'        pc.fmv_usd\n      FROM pinnacle_catalog pc\n      WHERE pc.series_name = v_pinnacle_year::text\n    ),\n    -- 2026-11-14: one row per pin x DISTINCT character (a pin tagged Ewok + Wicket counts for both),\n    -- matching get_player_detail; `ed` above stays one row per pin for the sets rollup.\n    ch AS (\n      SELECT regexp_replace(lower(c.name), \'[^a-z0-9]+\', \'-\', \'g\') AS player_slug,\n             c.name AS player_name,\n             pc.fmv_usd\n      FROM pinnacle_catalog pc\n      CROSS JOIN LATERAL (SELECT DISTINCT btrim(x) AS name FROM unnest(pc.characters) x WHERE btrim(x) <> \'\') c\n      WHERE pc.series_name = v_pinnacle_year::text\n    ),';
  b_old text := E'      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL\n      GROUP BY player_slug, player_name\n      ORDER BY fmv_total DESC LIMIT 12';
  b_new text := E'      FROM ch WHERE player_slug IS NOT NULL AND player_name IS NOT NULL\n      GROUP BY player_slug, player_name\n      ORDER BY fmv_total DESC LIMIT 12';
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> '8916f74397ab153be1fec1a5c0263f88' THEN
    RAISE EXCEPTION 'get_series_rollups base drifted: md5 %', md5(v_src);
  END IF;
  IF (length(v_src) - length(replace(v_src, a_old, ''))) / length(a_old) <> 1 THEN RAISE EXCEPTION 'anchor A not found exactly once'; END IF;
  IF (length(v_src) - length(replace(v_src, b_old, ''))) / length(b_old) <> 1 THEN RAISE EXCEPTION 'anchor B not found exactly once'; END IF;
  v_def := replace(replace(pg_get_functiondef(v_oid), a_old, a_new), b_old, b_new);
  EXECUTE v_def;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('characters[1]' IN v_src) > 0 OR position('FROM ch WHERE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
END $$;
