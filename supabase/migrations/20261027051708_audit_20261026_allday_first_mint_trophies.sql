-- audit_20261026: NFL All Day leg for /insights/first-mint (All Day ↔ Top Shot parity, pass 4).
--
-- Top Shot's First-Mint Trophy board (mv_topshot_first_mint_trophies) has no All Day equivalent. Same contract here:
-- every #1-serial sale in the last 90 days, against the average of that edition's OTHER serials over 180 days
-- (≥ 3 sales). Differences, on purpose:
--   * reads sales_market (pack buybacks excluded — a buyback is not a collector's price);
--   * a #1 sale whose buyer is its seller, or touching flowty_excluded_addresses, is left out;
--   * the 180-day baseline is computed only for editions that had a #1 sale (49k → far fewer buffers).
-- Read 10-26 ~10:30 PM PT: 27 trophies; median 22×; top Richard Sherman Common #1 $550 against a $0.35 average (38 sales).
-- Live, the query costs ~49k buffers (167 ms warm), so it is materialised and refreshed every 30 min like Top Shot's.
-- Service-role only: the public route reads it with the admin client. Views are security_invoker (as applied the views
-- were created without it and hardened by 20261027053839_audit_20261026_allday_first_mint_views_security_invoker).
--
-- Revert: SELECT cron.unschedule('allday-first-mint-mv');
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'allday-first-mint-mv';
--         DROP VIEW public.allday_first_mint_trophy_stats; DROP VIEW public.allday_first_mint_trophies;
--         DROP FUNCTION public.refresh_allday_first_mint_trophies(); DROP MATERIALIZED VIEW public.mv_allday_first_mint_trophies;

CREATE MATERIALIZED VIEW public.mv_allday_first_mint_trophies AS
WITH mint_one_sales AS (
  SELECT s.edition_id, s.price_usd, s.sold_at, s.transaction_hash
  FROM public.sales_market s
  WHERE s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND s.serial_number = 1
    AND s.price_usd > 0
    AND s.sold_at >= now() - interval '90 days'
    AND s.buyer_address IS DISTINCT FROM s.seller_address
    AND NOT EXISTS (SELECT 1 FROM public.flowty_excluded_addresses x WHERE x.address IN (s.buyer_address, s.seller_address))
), other_serial_avg AS (
  SELECT s.edition_id, avg(s.price_usd) AS avg_other_price, count(*)::integer AS sample_n
  FROM public.sales_market s
  WHERE s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND s.serial_number > 1
    AND s.price_usd > 0
    AND s.sold_at >= now() - interval '180 days'
    AND s.edition_id IN (SELECT edition_id FROM mint_one_sales)
  GROUP BY s.edition_id
  HAVING count(*) >= 3
)
SELECT e.id AS edition_id,
       e.external_id,
       e.player_name,
       e.set_name,
       e.tier::text AS tier,
       e.circulation_count,
       m.sold_at AS mint_one_sold_at,
       round(m.price_usd, 2) AS mint_one_price_usd,
       round(o.avg_other_price, 2) AS avg_other_serial_price_usd,
       o.sample_n AS other_serial_sample_n,
       round(m.price_usd / NULLIF(o.avg_other_price, 0), 1) AS multiplier,
       m.transaction_hash
FROM mint_one_sales m
JOIN other_serial_avg o ON o.edition_id = m.edition_id
JOIN public.editions e ON e.id = m.edition_id
ORDER BY (m.price_usd / NULLIF(o.avg_other_price, 0)) DESC NULLS LAST;

CREATE UNIQUE INDEX mv_allday_first_mint_trophies_key ON public.mv_allday_first_mint_trophies (edition_id, mint_one_sold_at, transaction_hash);

CREATE VIEW public.allday_first_mint_trophies WITH (security_invoker = on) AS
SELECT edition_id, external_id, player_name, set_name, tier, circulation_count, mint_one_sold_at, mint_one_price_usd,
       avg_other_serial_price_usd, other_serial_sample_n, multiplier, transaction_hash
FROM public.mv_allday_first_mint_trophies;

CREATE VIEW public.allday_first_mint_trophy_stats WITH (security_invoker = on) AS
SELECT count(*) AS trophies_90d,
       count(*) FILTER (WHERE multiplier >= 5) AS mult_5x_plus,
       count(*) FILTER (WHERE multiplier >= 10) AS mult_10x_plus,
       count(*) FILTER (WHERE multiplier >= 50) AS mult_50x_plus,
       count(*) FILTER (WHERE multiplier >= 100) AS mult_100x_plus,
       round(avg(multiplier), 1) AS avg_multiplier,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY multiplier::double precision))::numeric, 1) AS median_multiplier,
       max(multiplier) AS max_multiplier,
       max(mint_one_price_usd) AS top_mint_one_price_usd,
       now() AS computed_at
FROM public.allday_first_mint_trophies;

REVOKE ALL ON public.mv_allday_first_mint_trophies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.allday_first_mint_trophies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.allday_first_mint_trophy_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_allday_first_mint_trophies TO service_role;
GRANT SELECT ON public.allday_first_mint_trophies TO service_role;
GRANT SELECT ON public.allday_first_mint_trophy_stats TO service_role;

-- anon-exec: revoked (refresh_allday_first_mint_trophies) — pg_cron writer; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.refresh_allday_first_mint_trophies()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_allday_first_mint_trophies;
  SELECT count(*) INTO v_rows FROM public.mv_allday_first_mint_trophies;
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'allday-first-mint-mv',
    p_started_at   := v_started,
    p_rows_found   := v_rows,
    p_rows_written := v_rows,
    p_ok           := true,
    p_extra        := jsonb_build_object(
      'refresh_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'mv', 'mv_allday_first_mint_trophies')
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.refresh_allday_first_mint_trophies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_allday_first_mint_trophies() TO postgres, service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('allday-first-mint-mv', 120, 'info',
  'pg_cron 26,56 (30 min). Refreshes mv_allday_first_mint_trophies for the All Day leg of /insights/first-mint; the board stamps its data_as_of from this pipeline. audit_20261026.', 180)
ON CONFLICT DO NOTHING;

SELECT cron.schedule('allday-first-mint-mv', '26,56 * * * *', $$SELECT public.refresh_allday_first_mint_trophies()$$);
SELECT public.refresh_allday_first_mint_trophies();
