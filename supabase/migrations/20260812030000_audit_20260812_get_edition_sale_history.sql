-- audit_20260812_get_edition_sale_history
--
-- Long-horizon price history for an edition, built from ACTUAL SALES rather
-- than FMV snapshots.
--
-- WHY IT CANNOT COME FROM fmv_snapshots. The edition page's existing chart
-- (get_edition_fmv_history → FmvHistoryChart) offers 30d / 90d / 365d chips,
-- but `fmv_snapshots` only begins 2026-03-31 — about 4.5 months of history.
-- The "365d" chip has therefore never shown a year; it shows everything there
-- is and looks like a year. `sales` goes back to 2020-07-28 with 3.11M Top Shot
-- rows, so real 1-year and all-time views have to be derived from prints. That
-- is also the better number: a print is what someone actually paid, not a model
-- output.
--
-- GRAIN ADAPTS TO THE WINDOW, and the caller is told which grain it got
-- (`grain` is on every row) so the axis can be labelled honestly instead of
-- implying daily resolution on a 6-year chart:
--   window <= 120d  → day
--   window <= 800d  → week
--   otherwise / all → month
--
-- MEDIAN, NOT MEAN. A single whale print would drag a mean and misrepresent
-- what the edition trades at; `low`/`high` carry the spread separately.
--
-- p_days <= 0 or NULL means ALL TIME.
--
-- ZERO-PRICE ROWS ARE EXCLUDED. `sales` legitimately carries price_usd = 0 /
-- NULL rows (the parked-price cohort behind the AllDay unmapped backlog); they
-- are not trades and would drag every median toward zero.
--
-- PINNACLE reads its own `pinnacle_sales` (187k rows, from 2024-12-09), keyed
-- by render_id/edition_id with price column `sale_price_usd`, resolved exactly
-- the way get_edition_fmv_history resolves it so both charts agree on which
-- render the page is about.
--
-- TOP SHOT DUPE RESIDUE is not an issue here and deliberately not filtered:
-- measured live, sales attach ONLY to the canonical int-keyed edition rows
-- (the UUID twins hold 0 sales), and this function resolves a single edition
-- row the same way the FMV history function does.

CREATE OR REPLACE FUNCTION public.get_edition_sale_history(
  p_collection_id uuid,
  p_route_slug    text,
  p_days          int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_all           boolean := (p_days IS NULL OR p_days <= 0);
  v_days          int := LEAST(GREATEST(COALESCE(p_days, 0), 0), 4000);
  v_cutoff        timestamptz := CASE WHEN v_all THEN '-infinity'::timestamptz
                                      ELSE now() - (v_days || ' days')::interval END;
  v_grain         text := CASE
                            WHEN NOT v_all AND v_days <= 120 THEN 'day'
                            WHEN NOT v_all AND v_days <= 800 THEN 'week'
                            ELSE 'month'
                          END;
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    WITH r AS (
      SELECT pc.render_id
      FROM pinnacle_catalog pc
      WHERE pc.render_id = p_route_slug
         OR pc.edition_id = p_route_slug
      ORDER BY (pc.render_id = p_route_slug) DESC,
               pc.fmv_sales_count_30d DESC NULLS LAST,
               pc.total_minted ASC NULLS LAST
      LIMIT 1
    ),
    bucketed AS (
      SELECT
        date_trunc(v_grain, ps.sold_at)::date                                   AS bucket,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.sale_price_usd)::numeric AS median_usd,
        min(ps.sale_price_usd)                                                  AS low_usd,
        max(ps.sale_price_usd)                                                  AS high_usd,
        count(*)::int                                                           AS sales_count,
        v_grain                                                                 AS grain
      FROM r
      JOIN pinnacle_sales ps
        ON ps.render_id = r.render_id
      WHERE ps.sold_at >= v_cutoff
        AND ps.sale_price_usd IS NOT NULL
        AND ps.sale_price_usd > 0
      GROUP BY 1
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(bucketed.*) ORDER BY bucketed.bucket), '[]'::jsonb)
    INTO result
    FROM bucketed;
  ELSE
    WITH ed AS (
      SELECT id FROM editions
      WHERE collection_id = p_collection_id
        AND (external_id = p_route_slug OR id::text = p_route_slug)
      LIMIT 1
    ),
    bucketed AS (
      SELECT
        date_trunc(v_grain, s.sold_at)::date                                AS bucket,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)::numeric   AS median_usd,
        min(s.price_usd)                                                    AS low_usd,
        max(s.price_usd)                                                    AS high_usd,
        count(*)::int                                                       AS sales_count,
        v_grain                                                             AS grain
      FROM ed
      JOIN sales s ON s.edition_id = ed.id
      WHERE s.sold_at >= v_cutoff
        AND s.price_usd IS NOT NULL
        AND s.price_usd > 0
      GROUP BY 1
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(bucketed.*) ORDER BY bucketed.bucket), '[]'::jsonb)
    INTO result
    FROM bucketed;
  END IF;

  RETURN result;
END
$fn$;

COMMENT ON FUNCTION public.get_edition_sale_history(uuid, text, int) IS
  'Sale-print price history for one edition, bucketed day/week/month by window '
  'size (grain is returned on every row). Median, not mean. Excludes price 0/NULL. '
  'p_days <= 0 or NULL = all time. Exists because fmv_snapshots only starts '
  '2026-03-31 while sales go back to 2020, so 1y/all-time cannot come from FMV.';

REVOKE EXECUTE ON FUNCTION public.get_edition_sale_history(uuid, text, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_edition_sale_history(uuid, text, int) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_edition_sale_history(uuid, text, int) TO service_role;
