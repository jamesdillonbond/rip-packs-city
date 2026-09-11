-- anon-exec: revoked — series_display_label needs no anon or authenticated grant; its only callers are SECURITY DEFINER readers that execute it as their definer. The REVOKE itself ships in 20260911061450_audit_20260911_series_display_label_states_its_anon_exec_decision.
-- (Marker line appended to this stored migration on 2026-09-11 so migration-autorecover's gate can commit the file; the SQL below is byte-for-byte what executed.)
-- 2026-09-11 (Cowork deep-audit/QA pass, Trevor-reported).
--
-- THE DEFECT. Three read RPCs emitted `series_label` as the BARE on-chain
-- integer (`e.series::text`). The edition/moment page and the set/series
-- edition grids render that value verbatim, so an edition sat next to
-- "Mint 1,000" showing a naked "5" with no clue what the 5 meant.
--
-- ⚠ AND PREFIXING ALONE WOULD HAVE SHIPPED A LIE. On Top Shot the on-chain
-- number is NOT the display ordinal — on-chain 5 IS "Series 4" (there is no
-- on-chain series 1; series 0 IS Series 1). "Series 5" would have been both
-- contextful and wrong, so this maps rather than concatenates.
--
-- ⚠ IT ALSO DECLINES TO SETTLE THE OPEN ORDINAL CONFLICT. For on-chain 6/7/8
-- the repo map (lib/series-label.ts) says "Series 2023-24/2024-25/2025-26"
-- while collection_series.display_label says "Series 5/6/7" — still open (see
-- CLAUDE.md series map). BOTH sources agree on the SEASON, so the helper emits
-- the season form there. That reproduces lib/series-label.ts `seriesDisplay()`
-- EXACTLY for every mapped case, so the edition page now AGREES with the moment
-- page and the trophy slab instead of introducing a third spelling.
--
-- ⚠ SAFE FOR THE SEO LAYER. lib/seo.ts `formatSeriesLabel()` maps a NUMERIC
-- label and returns a non-numeric one AS-IS, so meta titles are unchanged —
-- they were already correct; only the on-page chip was naked.
--
-- REVERT: see the bottom of this file.

-- ── 1. One map, one place ────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: every caller is SECURITY DEFINER, so this runs
-- as the definer inside them and needs no grant of its own — which also keeps
-- it out of check_secdef_anon_exec_drift()'s surface.
CREATE OR REPLACE FUNCTION public.series_display_label(p_collection_id uuid, p_series int)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_label  text;
  v_season text;
  v_slug   text;
BEGIN
  IF p_series IS NULL THEN RETURN NULL; END IF;

  SELECT c.slug INTO v_slug FROM public.collections c WHERE c.id = p_collection_id;

  -- series_number is the on-chain key. The `season` fallback is for Disney
  -- Pinnacle, whose editions carry the YEAR (2024) where collection_series
  -- keys on an ordinal (2) and parks the year in `season`.
  SELECT cs.display_label, cs.season INTO v_label, v_season
  FROM public.collection_series cs
  WHERE cs.collection_id = p_collection_id
    AND (cs.series_number = p_series OR cs.season = p_series::text)
  ORDER BY (cs.series_number = p_series) DESC
  LIMIT 1;

  IF v_slug = 'nba_top_shot' AND p_series >= 6 AND v_season IS NOT NULL THEN
    RETURN 'Series ' || v_season;
  END IF;

  IF v_label IS NULL OR btrim(v_label) = '' THEN
    RETURN 'Series ' || p_series::text;
  END IF;

  -- A label that already READS as a phrase ("Summer 2021") is returned as-is;
  -- one that starts with a digit ("2024") gets the missing noun.
  IF v_label ~ '^[0-9]' THEN
    RETURN 'Series ' || v_label;
  END IF;

  RETURN v_label;
END;
$fn$;

COMMENT ON FUNCTION public.series_display_label(uuid, int) IS
  'On-chain series int -> display label. Mirrors lib/series-label.ts seriesDisplay(). 2026-09-11.';

-- ── 2. Rewrite the three emitters in place ───────────────────────────────────
-- Done as a scripted regexp rewrite of pg_get_functiondef rather than by
-- retyping 17KB of SQL, so the bodies cannot drift on a transcription slip.
-- ⚠ EVERY SUBSTITUTION COUNT IS ASSERTED — a silent no-op replace is the exact
-- shape that has produced a "result" off an unchanged baseline before.
DO $do$
DECLARE
  r            record;
  d            text;
  d2           text;
  v_hits       int;
  v_expected   int;
  v_total      int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname,
           CASE p.proname
             WHEN 'get_edition_detail'  THEN 2   -- editions branch + pinnacle branch
             WHEN 'get_set_editions'    THEN 1   -- pinnacle branch already emits pc.series_name
             WHEN 'get_series_editions' THEN 3   -- 2 editions branches + pinnacle
           END AS expect
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_edition_detail','get_set_editions','get_series_editions')
  LOOP
    d := pg_get_functiondef(r.oid);
    v_expected := r.expect;

    -- jsonb_build_object form:  'series_label',  <expr>
    d2 := regexp_replace(d,
            '(''series_label'',\s*)e\.series::text',
            '\1public.series_display_label(p_collection_id, e.series::int)', 'g');
    d2 := regexp_replace(d2,
            '(''series_label'',\s*)pe\.series_year::text',
            '\1public.series_display_label(p_collection_id, pe.series_year::int)', 'g');

    -- SELECT-list form:  <expr>  AS series_label
    d2 := regexp_replace(d2,
            'e\.series::text(\s+)AS series_label',
            'public.series_display_label(p_collection_id, e.series::int)\1AS series_label', 'g');
    d2 := regexp_replace(d2,
            'pe\.series_year::text(\s+)AS series_label',
            'public.series_display_label(p_collection_id, pe.series_year::int)\1AS series_label', 'g');

    v_hits := (length(d2) - length(d)) ; -- only used for the "changed at all" check
    SELECT count(*) INTO v_hits
    FROM regexp_matches(d2, 'public\.series_display_label\(p_collection_id', 'g');

    IF v_hits <> v_expected THEN
      RAISE EXCEPTION 'series_label rewrite: % expected % substitutions, got %',
        r.proname, v_expected, v_hits;
    END IF;

    EXECUTE d2;
    v_total := v_total + v_hits;
  END LOOP;

  IF v_total <> 6 THEN
    RAISE EXCEPTION 'series_label rewrite: expected 6 substitutions across 3 functions, got %', v_total;
  END IF;
END
$do$;

-- REVERT
--   The three functions are restored by re-running their most recent prior
--   migration (find by message, not sha: git log --grep=get_edition_detail /
--   --grep=get_set_editions / --grep=get_series_editions), then
--   DROP FUNCTION public.series_display_label(uuid, int);
--   Nothing else reads the helper.