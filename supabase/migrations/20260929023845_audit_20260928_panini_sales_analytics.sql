CREATE OR REPLACE FUNCTION public.panini_sales_analytics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH params AS (
    SELECT LEAST(GREATEST(COALESCE(p_days, 30), 1), 90) AS days,
           (now() AT TIME ZONE 'America/Los_Angeles')::date AS today_pt
  ), days AS (
    SELECT d::date AS day,
           (d::date::timestamp AT TIME ZONE 'America/Los_Angeles') AS day_start,
           ((d::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles') AS day_end
    FROM params, generate_series(params.today_pt - (params.days - 1), params.today_pt, interval '1 day') d
  ), active AS (
    SELECT DISTINCT edition_external_id
    FROM panini_sales
    WHERE sold_at > now() - interval '90 days'
  ), cov AS (
    SELECT d.day,
           count(*) FILTER (WHERE r.complete_since <= d.day_start AND r.last_recent_read_at >= d.day_end) AS covered
    FROM days d
    CROSS JOIN active a
    LEFT JOIN panini_sales_reads r ON r.edition_external_id = a.edition_external_id
    GROUP BY d.day
  ), win AS (
    SELECT s.*, (s.sold_at AT TIME ZONE 'America/Los_Angeles')::date AS day
    FROM panini_sales s, params
    WHERE s.sold_at >= ((params.today_pt - (params.days - 1))::timestamp AT TIME ZONE 'America/Los_Angeles')
  ), daily AS (
    SELECT d.day,
           count(w.sku) AS sales,
           round(coalesce(sum(w.amount_usd), 0), 2) AS volume_usd,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w.amount_usd::float8)::numeric, 2) AS median_usd,
           round(100.0 * c.covered / NULLIF((SELECT count(*) FROM active), 0), 1) AS covered_pct
    FROM days d
    LEFT JOIN win w ON w.day = d.day
    LEFT JOIN cov c ON c.day = d.day
    GROUP BY d.day, c.covered
  ), named AS (
    SELECT s.sku, s.edition_external_id, s.sold_at, s.amount_usd, s.source,
           pe.player_name, pe.set_name, pe.tier::text AS tier,
           CASE WHEN s.sku ~ '__\d{1,6}_\d{1,6}$' THEN split_part(split_part(s.sku, '__', 2), '_', 1)::int END AS serial_number,
           CASE WHEN s.sku ~ '__\d{1,6}_\d{1,6}$' THEN split_part(split_part(s.sku, '__', 2), '_', 2)::int END AS mint_cap
    FROM panini_sales s
    LEFT JOIN panini_editions pe ON pe.external_id = s.edition_external_id
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'days', (SELECT days FROM params),
    'coverage', jsonb_build_object(
      'active_editions',         (SELECT count(*) FROM active),
      'editions_read',           (SELECT count(*) FROM panini_sales_reads),
      'editions_whole_history',  (SELECT count(*) FROM panini_sales_reads WHERE complete_since = '-infinity'),
      'editions_with_gaps',      (SELECT count(*) FROM panini_sales_reads WHERE gaps > 0),
      'first_read_at',           (SELECT min(first_recent_read_at) FROM panini_sales_reads),
      'last_read_at',            (SELECT max(last_recent_read_at) FROM panini_sales_reads),
      'sales_held',              (SELECT count(*) FROM panini_sales),
      'sales_from_full_records', (SELECT count(*) FROM panini_sales WHERE source = 'nft_sales_data')
    ),
    'daily', COALESCE((SELECT jsonb_agg(to_jsonb(x.*) ORDER BY x.day) FROM daily x), '[]'::jsonb),
    'window', (SELECT jsonb_build_object(
                 'sales', count(*),
                 'volume_usd', round(coalesce(sum(amount_usd), 0), 2),
                 'median_usd', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_usd::float8)::numeric, 2),
                 'editions_traded', count(DISTINCT edition_external_id),
                 'cards_traded', count(DISTINCT sku))
               FROM win),
    'top_sales_window', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.amount_usd DESC, t.sold_at DESC)
      FROM (SELECT n.* FROM named n, params WHERE n.sold_at >= ((params.today_pt - (params.days - 1))::timestamp AT TIME ZONE 'America/Los_Angeles')
            ORDER BY n.amount_usd DESC, n.sold_at DESC LIMIT 15) t), '[]'::jsonb),
    'top_sales_all_time', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.amount_usd DESC, t.sold_at DESC)
      FROM (SELECT * FROM named ORDER BY amount_usd DESC, sold_at DESC LIMIT 15) t), '[]'::jsonb),
    'most_traded', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.sales DESC, t.volume_usd DESC)
      FROM (SELECT w.edition_external_id, pe.player_name, pe.set_name, pe.tier::text AS tier,
                   count(*) AS sales, round(sum(w.amount_usd), 2) AS volume_usd,
                   round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w.amount_usd::float8)::numeric, 2) AS median_usd
            FROM win w LEFT JOIN panini_editions pe ON pe.external_id = w.edition_external_id
            GROUP BY w.edition_external_id, pe.player_name, pe.set_name, pe.tier
            ORDER BY count(*) DESC, sum(w.amount_usd) DESC, w.edition_external_id LIMIT 15) t), '[]'::jsonb),
    'by_tier', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.volume_usd DESC)
      FROM (SELECT coalesce(pe.tier::text, 'UNKNOWN') AS tier, count(*) AS sales, round(sum(w.amount_usd), 2) AS volume_usd,
                   round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w.amount_usd::float8)::numeric, 2) AS median_usd
            FROM win w LEFT JOIN panini_editions pe ON pe.external_id = w.edition_external_id
            GROUP BY 1) t), '[]'::jsonb),
    'by_parallel', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.volume_usd DESC)
      FROM (SELECT coalesce(pe.set_name, 'Not in RPC''s catalogue') AS parallel, count(*) AS sales, round(sum(w.amount_usd), 2) AS volume_usd,
                   round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w.amount_usd::float8)::numeric, 2) AS median_usd
            FROM win w LEFT JOIN panini_editions pe ON pe.external_id = w.edition_external_id
            GROUP BY 1 ORDER BY sum(w.amount_usd) DESC LIMIT 15) t), '[]'::jsonb)
  )
$$;

COMMENT ON FUNCTION public.panini_sales_analytics(integer) IS
  'Panini Analytics tab: sales RPC holds (panini_sales) over the last p_days PT days, with per-day coverage (covered_pct of editions active in 90 d) so a day is called complete only when it is.';

REVOKE ALL ON FUNCTION public.panini_sales_analytics(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_sales_analytics(integer) TO service_role;