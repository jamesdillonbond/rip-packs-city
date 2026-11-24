-- audit_20261123_panini_scarcer_for_less
--
-- anon-exec: revoked (refresh_panini_scarcer_for_less) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; postgres + service_role only.
--
-- 2026-11-23 (Claude Code cloud; Trevor: "Keep going" — enhance Panini on the site).
--
-- WHAT. A "Scarcer for less" board for /insights/panini-squeeze: a Panini printing LISTED BELOW what a MORE COMMON
-- printing of the same card has been SELLING for. A Panini card's parallels are separate editions of one product +
-- player + card number + parallel family (the ladder lib/panini/edition-printings.ts draws on edition pages); a /25
-- listed under the 90-day median sale of the same card's /99 is a market fact a collector can act on.
--
-- Built from facts only — no FMV, no confidence:
--   low_ask        the printing's cheapest listed serial re-read in the last 7 days (the FMV ask-cap's 7-day rule)
--   common_*       the more-common sibling (higher mint cap, same family) with the LOWEST 90-day median sale among those
--                  with >= 3 sales in 90 days — the most conservative comparison available, so a single high sale or an
--                  absurd ask on the common printing can never make the gap
--   own_*          the printing's own 90-day sales, shown beside it (a printing that has itself sold for less says so)
-- Only rows where low_ask < common_median and common_median >= $2 (dust excluded).
--
-- FAMILY (SQL mirror of paniniParallelFamily): "<card> [Preferred|Choice] Prizms …" → "<card>"; else the longest
-- sibling set name (same product + player + card number) that the name extends by a word ("Base" for "Base Green");
-- else the name itself. Card number = the external id's last `_` segment (packcard-<product>_<cardset>_<card>_<n>).
--
-- MEASURED 11-23: 1,301 rows; the build is 9.4 s / ~143k buffers (the 90-day sales aggregate is most of it) — so every
-- 2 hours at :08, not hourly. A read is a PK / sort scan of ~1.3k rows.
--
-- REVERT:
--   SELECT cron.unschedule('panini-scarcer-for-less');
--   DROP FUNCTION public.refresh_panini_scarcer_for_less(); DROP MATERIALIZED VIEW public.mv_panini_scarcer_for_less;
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'panini-scarcer-for-less';

CREATE MATERIALIZED VIEW public.mv_panini_scarcer_for_less AS
WITH ask AS (
  SELECT s.edition_external_id, min(s.price_usd) AS low_ask
    FROM public.panini_card_serials s
   WHERE s.is_listed AND s.price_usd > 0 AND s.captured_at > now() - interval '7 days'
   GROUP BY 1
), sold AS (
  SELECT x.edition_external_id, count(*)::integer AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (x.amount_usd)::double precision) AS med
    FROM public.panini_sales x
   WHERE x.amount_usd > 0 AND x.sold_at > now() - interval '90 days'
   GROUP BY 1
), ed AS (
  SELECT pe.external_id, pe.product_set_id, pe.player_name, trim(pe.set_name) AS set_name, pe.mint_cap,
         (regexp_match(pe.external_id, '_([0-9]+)$'))[1] AS num
    FROM public.panini_editions pe
   WHERE pe.external_id LIKE 'packcard-%' AND pe.set_name IS NOT NULL AND pe.mint_cap > 0 AND pe.player_name IS NOT NULL
), pre AS (
  SELECT DISTINCT ON (e.external_id) e.external_id, s.set_name AS fam
    FROM ed e
    JOIN ed s ON s.product_set_id = e.product_set_id AND s.player_name = e.player_name AND s.num = e.num
             AND e.set_name LIKE s.set_name || ' %'
   ORDER BY e.external_id, length(s.set_name) DESC
), fam AS (
  SELECT e.*,
         COALESCE(NULLIF(trim((regexp_match(e.set_name, '^(.*?)\s+(?:(?:Preferred|Choice)\s+)?Prizms(?:\s|$)'))[1]), ''),
                  p.fam, e.set_name) AS family,
         a.low_ask, so.n AS sales_n, so.med AS sales_med
    FROM ed e
    LEFT JOIN pre p USING (external_id)
    LEFT JOIN ask a ON a.edition_external_id = e.external_id
    LEFT JOIN sold so ON so.edition_external_id = e.external_id
   WHERE e.num IS NOT NULL
), pick AS (
  SELECT DISTINCT ON (a.external_id)
         a.external_id, a.product_set_id, a.player_name, a.set_name, a.mint_cap, a.low_ask,
         a.sales_n AS own_sales_n, a.sales_med AS own_median,
         c.external_id AS common_external_id, c.set_name AS common_set_name, c.mint_cap AS common_mint_cap,
         c.sales_n AS common_sales_n, c.sales_med AS common_median
    FROM fam a
    JOIN fam c ON c.product_set_id = a.product_set_id AND c.player_name = a.player_name AND c.num = a.num
              AND c.family = a.family AND c.mint_cap > a.mint_cap AND c.sales_n >= 3
   WHERE a.low_ask IS NOT NULL
   ORDER BY a.external_id, c.sales_med, c.mint_cap DESC, c.external_id
)
SELECT k.external_id,
       k.player_name,
       k.set_name,
       k.mint_cap,
       pr.name AS product_name,
       pr.last_grid_sport AS sport,
       k.low_ask AS low_ask_usd,
       COALESCE(k.own_sales_n, 0) AS own_sales_90d,
       round(k.own_median::numeric, 2) AS own_median_90d_usd,
       k.common_external_id,
       k.common_set_name,
       k.common_mint_cap,
       k.common_sales_n AS common_sales_90d,
       round(k.common_median::numeric, 2) AS common_median_90d_usd,
       round(k.common_median::numeric - k.low_ask, 2) AS gap_usd,
       round(((k.common_median::numeric - k.low_ask) / k.common_median::numeric) * 100, 1) AS gap_pct,
       now() AS computed_at
  FROM pick k
  LEFT JOIN public.panini_products pr ON pr.set_id = k.product_set_id
 WHERE k.low_ask < k.common_median::numeric AND k.common_median >= 2;

CREATE UNIQUE INDEX mv_panini_scarcer_for_less_pk ON public.mv_panini_scarcer_for_less USING btree (external_id);
CREATE INDEX mv_panini_scarcer_for_less_gap ON public.mv_panini_scarcer_for_less USING btree (gap_usd DESC, external_id);

REVOKE ALL ON public.mv_panini_scarcer_for_less FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_panini_scarcer_for_less TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_panini_scarcer_for_less()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_scarcer_for_less;
  SELECT count(*) INTO v_rows FROM public.mv_panini_scarcer_for_less;
  PERFORM public.log_pipeline_run('panini-scarcer-for-less', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-scarcer-for-less', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_panini_scarcer_for_less() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_scarcer_for_less() TO service_role;

SELECT cron.schedule('panini-scarcer-for-less', '8 */2 * * *', 'SELECT public.refresh_panini_scarcer_for_less()');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('panini-scarcer-for-less', 240, 'info', 'pg_cron 8 */2 * * * (every 2 h). refresh_panini_scarcer_for_less — the Scarcer for less tab on /insights/panini-squeeze. audit_20261123.', true, 360)
ON CONFLICT (pipeline) DO NOTHING;

COMMENT ON MATERIALIZED VIEW public.mv_panini_scarcer_for_less IS
  'Panini printings listed (7-day confirmed ask) below the lowest 90-day median sale of a MORE COMMON printing of the same card (product + player + card number + parallel family; >= 3 sales). Every 2 h at :08 via refresh_panini_scarcer_for_less(). 2026-11-23.';
