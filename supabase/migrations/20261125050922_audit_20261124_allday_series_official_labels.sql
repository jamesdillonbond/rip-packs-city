UPDATE public.collection_series
   SET season = CASE series_number WHEN 2 THEN '2022' WHEN 4 THEN '2023' WHEN 6 THEN '2024'
                                   WHEN 8 THEN '2025' WHEN 10 THEN '2026' END
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
   AND series_number IN (2, 4, 6, 8, 10);

-- anon-exec: unchanged (series_display_label) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false authenticated=false 2026-11-24.
CREATE OR REPLACE FUNCTION public.series_display_label(p_collection_id uuid, p_series integer)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_label  text;
  v_season text;
  v_slug   text;
BEGIN
  IF p_series IS NULL THEN RETURN NULL; END IF;

  SELECT c.slug INTO v_slug FROM public.collections c WHERE c.id = p_collection_id;

  SELECT cs.display_label, cs.season INTO v_label, v_season
  FROM public.collection_series cs
  WHERE cs.collection_id = p_collection_id
    AND (
      cs.series_number = p_series
      OR (v_slug = 'disney_pinnacle' AND cs.season = p_series::text)
    )
  ORDER BY (cs.series_number = p_series) DESC
  LIMIT 1;

  -- Top Shot retired the ordinal after Series 4. The repo map and
  -- collection_series disagree on the ORDINAL for on-chain 6/7/8 (open — see
  -- CLAUDE.md) but AGREE on the season, so the season form is the answer that
  -- does not take a side, and it reproduces lib/series-label.ts exactly.
  IF v_slug = 'nba_top_shot' AND p_series >= 6 AND v_season IS NOT NULL THEN
    RETURN 'Series ' || v_season;
  END IF;

  -- NFL All Day (2026-11-24): on-chain series interleave contemporary seasons
  -- (odd) and Historical releases (even). These are the contract's own names
  -- (AllDay.getSeriesData); display_label stays the URL key.
  IF v_slug = 'nfl_all_day' THEN
    IF p_series = 1 THEN RETURN 'Series 1'; END IF;
    IF p_series = 2 THEN RETURN 'Historical'; END IF;
    IF p_series = 3 THEN RETURN 'Series 2'; END IF;
    IF p_series = 4 THEN RETURN 'Historical 2'; END IF;
    IF v_season IS NOT NULL AND p_series % 2 = 1 THEN RETURN v_season || ' Season'; END IF;
    IF v_season IS NOT NULL AND p_series % 2 = 0 THEN RETURN 'Historical (' || v_season || ' Release)'; END IF;
    RETURN 'Series ' || p_series::text;
  END IF;

  IF v_label IS NULL OR btrim(v_label) = '' THEN
    RETURN 'Series ' || p_series::text;
  END IF;

  IF v_label ~ '^[0-9]' THEN
    RETURN 'Series ' || v_label;
  END IF;

  RETURN v_label;
END;
$function$;