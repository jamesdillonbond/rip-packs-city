-- audit_20260929_panini_sales_analytics_serial_premium
--
-- Adds 'serial_premium' to panini_sales_analytics: what serial #1, the last serial of the run,
-- and #2-10 sell for as a multiple of the same edition's usual price (the median of its other
-- sales, where at least 3 are on record), by print run, over every Panini sale RPC holds.
-- Measured 2026-09-29 over 56,664 sales: #1 at a median 1.44-2.18x, the last serial 1.23-1.67x,
-- #2-10 at 1.00x. The block costs ~230 ms / 1.3k buffers (a seq scan of panini_sales) on top of
-- the function's ~230 ms (measured whole: 680 ms, 28.8k buffers). Every other key unchanged.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the existing ACL (service_role only; verified before) (public.panini_sales_analytics)

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
  ), top_all AS (
    -- LIMIT before the name join, off idx_panini_sales_amount (a full sort of every sale
    -- grew with the table: 22k buffers + temp spill at 52k rows, 2026-09-28).
    SELECT s.sku, s.edition_external_id, s.sold_at, s.amount_usd, s.source
    FROM panini_sales s
    ORDER BY s.amount_usd DESC, s.sold_at DESC
    LIMIT 15
  ), top_win AS (
    SELECT w.sku, w.edition_external_id, w.sold_at, w.amount_usd, w.source
    FROM win w
    ORDER BY w.amount_usd DESC, w.sold_at DESC
    LIMIT 15
  ), named AS (
    SELECT t.list, t.sku, t.edition_external_id, t.sold_at, t.amount_usd, t.source,
           pe.player_name, pe.set_name, pe.tier::text AS tier,
           CASE WHEN t.sku ~ '__\d{1,6}_\d{1,6}$' THEN split_part(split_part(t.sku, '__', 2), '_', 1)::int END AS serial_number,
           CASE WHEN t.sku ~ '__\d{1,6}_\d{1,6}$' THEN split_part(split_part(t.sku, '__', 2), '_', 2)::int END AS mint_cap
    FROM (SELECT 'all' AS list, * FROM top_all UNION ALL SELECT 'win' AS list, * FROM top_win) t
    LEFT JOIN panini_editions pe ON pe.external_id = t.edition_external_id
  ), serials AS (
    -- Every sale on record with a parseable serial (all time: premiums need volume, and the
    -- multiple is relative to the same edition's other sales, so drift over time cancels).
    SELECT s.edition_external_id AS e, s.amount_usd AS a,
           split_part(split_part(s.sku, '__', 2), '_', 1)::int AS sn,
           split_part(split_part(s.sku, '__', 2), '_', 2)::int AS cap
    FROM panini_sales s
    WHERE s.sku ~ '__\d{1,6}_\d{1,6}$' AND s.amount_usd > 0
  ), serial_base AS (
    -- An edition's usual price: the median of its sales EXCLUDING #1 and the last serial,
    -- only where at least 3 such sales are on record.
    SELECT e, percentile_cont(0.5) WITHIN GROUP (ORDER BY a::float8) AS m
    FROM serials
    WHERE sn <> 1 AND sn <> cap
    GROUP BY e
    HAVING count(*) >= 3
  ), serial_kind AS (
    SELECT CASE WHEN s.sn = 1 THEN 'serial_1' WHEN s.sn = s.cap THEN 'last' WHEN s.sn <= 10 THEN 'serial_2_10' ELSE 'other' END AS kind,
           CASE WHEN s.cap <= 10 THEN '1-10' WHEN s.cap <= 25 THEN '11-25' WHEN s.cap <= 99 THEN '26-99' ELSE '100+' END AS print_run,
           s.a::float8 / b.m AS r
    FROM serials s JOIN serial_base b USING (e)
    WHERE b.m > 0
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
      SELECT jsonb_agg(to_jsonb(t.*) - 'list' ORDER BY t.amount_usd DESC, t.sold_at DESC)
      FROM named t WHERE t.list = 'win'), '[]'::jsonb),
    'top_sales_all_time', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) - 'list' ORDER BY t.amount_usd DESC, t.sold_at DESC)
      FROM named t WHERE t.list = 'all'), '[]'::jsonb),
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
            GROUP BY 1 ORDER BY sum(w.amount_usd) DESC LIMIT 15) t), '[]'::jsonb),
    'by_player', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) ORDER BY t.volume_usd DESC, t.sales DESC, t.player_name)
      FROM (SELECT pe.player_name, count(*) AS sales, round(sum(w.amount_usd), 2) AS volume_usd,
                   round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w.amount_usd::float8)::numeric, 2) AS median_usd,
                   count(DISTINCT w.edition_external_id) AS editions_traded
            FROM win w JOIN panini_editions pe ON pe.external_id = w.edition_external_id
            WHERE pe.player_name IS NOT NULL
            GROUP BY pe.player_name
            ORDER BY sum(w.amount_usd) DESC, count(*) DESC, pe.player_name LIMIT 15) t), '[]'::jsonb),
    'serial_premium', COALESCE((
      SELECT jsonb_agg(to_jsonb(t.*) - 'print_run_order' - 'kind_order' ORDER BY t.print_run_order, t.kind_order)
      FROM (SELECT kind, print_run,
                   CASE print_run WHEN '1-10' THEN 1 WHEN '11-25' THEN 2 WHEN '26-99' THEN 3 ELSE 4 END AS print_run_order,
                   CASE kind WHEN 'serial_1' THEN 1 WHEN 'last' THEN 2 WHEN 'serial_2_10' THEN 3 ELSE 4 END AS kind_order,
                   count(*) AS sales,
                   round(percentile_cont(0.5) WITHIN GROUP (ORDER BY r)::numeric, 2) AS median_multiple,
                   round(percentile_cont(0.25) WITHIN GROUP (ORDER BY r)::numeric, 2) AS p25_multiple,
                   round(percentile_cont(0.75) WITHIN GROUP (ORDER BY r)::numeric, 2) AS p75_multiple
            FROM serial_kind
            GROUP BY kind, print_run) t), '[]'::jsonb)
  )
$$;

