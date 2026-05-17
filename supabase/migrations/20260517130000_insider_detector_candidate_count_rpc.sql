-- public.count_insider_detector_candidates(p_slug text, p_detector text)
-- Returns the count of rows that would have passed the OUTERMOST gating
-- CTE of the named detector, BEFORE per-tier dollar floors, baseline
-- ratios, or dedup against topshot_insider_alerts. Lets the
-- run-insider-detectors cron route record candidates_evaluated in
-- pipeline_runs.extra so a 0-alert run is interpretable ("no candidates
-- existed" vs. "candidates existed but threshold-rejected").
CREATE OR REPLACE FUNCTION public.count_insider_detector_candidates(
  p_slug text,
  p_detector text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_collection_id uuid;
  v_count int := 0;
BEGIN
  SELECT id INTO v_collection_id FROM public.collections WHERE slug = p_slug;
  IF v_collection_id IS NULL THEN
    RETURN -1;
  END IF;

  IF p_detector = 'unusual_volume' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id
      FROM public.sales s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      HAVING COUNT(*) >= 5
    ) t;
  ELSIF p_detector = 'floor_drops' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id
      FROM public.sales s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      HAVING COUNT(*) >= 3
    ) t;
  ELSIF p_detector = 'concentration_buys' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id, s.buyer_address
      FROM public.sales s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
        AND s.buyer_address IS NOT NULL
        AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510')
      GROUP BY s.edition_id, s.buyer_address
      HAVING COUNT(*) >= 5
    ) t;
  ELSIF p_detector = 'early_buyers' THEN
    SELECT COUNT(*) INTO v_count FROM (
      WITH efs AS (
        SELECT s.edition_id, MIN(s.sold_at) AS first_sale_at
        FROM public.sales s
        WHERE s.collection_id = v_collection_id AND s.edition_id IS NOT NULL
        GROUP BY s.edition_id
        HAVING MIN(s.sold_at) > NOW() - INTERVAL '7 days'
      )
      SELECT s.edition_id, s.buyer_address
      FROM public.sales s
      JOIN efs ON efs.edition_id = s.edition_id
      WHERE s.collection_id = v_collection_id
        AND s.sold_at <= efs.first_sale_at + INTERVAL '48 hours'
        AND s.buyer_address IS NOT NULL
        AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510')
      GROUP BY s.edition_id, s.buyer_address
      HAVING COUNT(*) >= 3
    ) t;
  ELSE
    RETURN -1;
  END IF;

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.count_insider_detector_candidates(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_insider_detector_candidates(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.count_insider_detector_candidates(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.count_insider_detector_candidates(text, text) TO postgres, service_role;
