-- audit_20261123_panini_serial_premiums_precomputed
--
-- anon-exec: revoked (refresh_panini_serial_premiums) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; postgres + service_role only.
--
-- 2026-11-23 (Claude Code cloud; Trevor: "Keep going" on the Panini roadmap).
--
-- WHY. panini_serial_premiums (the "#1 / perfect mint sold at 2x+" half of /insights/panini-premiums, also read by the
-- concierge) re-aggregates 90 days of panini_sales on EVERY read. pg_stat_statements 11-23: 1,822 calls, mean 5.18 s,
-- max 18.9 s, ~14,000 disk blocks read per call — ~2.6 h of DB time, for 583 rows.
-- (Those are cumulative pgss figures; the body measured warm on 11-23 as the first refresh: 1.9 s. Either way it was
-- paid per read; now it is paid once an hour, and a read is an index scan: 0.3 ms, 96 buffers.)
-- The page already carries a 25 s
-- read budget for exactly this and its header names the structural fix: "a precomputed matview for the serial board;
-- when it lands, drop this." This is that matview.
--
-- WHAT. mv_panini_serial_premiums = the view's body verbatim (plus computed_at), unique on (sku, sold_at) — panini_sales'
-- own primary key, so one sale is one row (583 rows, 583 distinct keys, read 11-23). panini_serial_premiums becomes a
-- thin view over it with the SAME 16 columns in the same order (CREATE OR REPLACE, security_invoker kept, ACL kept),
-- so no reader changes. Refreshed hourly at :20 by refresh_panini_serial_premiums(), logged as
-- 'panini-serial-premiums'. Freshness cost: up to an hour, on a feed that lands sales 12–160 h after sold_at.
-- The 90-day window is now relative to the refresh, not the read — at most an hour of drift.
--
-- Premise: md5(pg_get_viewdef(panini_serial_premiums)) = 0bb5d9fa96320274898af8cb2a6476bb as read 11-23.
--
-- REVERT: re-apply the view body from 20261010225109_audit_20261010_panini_parallel_and_serial_premiums.sql
--   (CREATE OR REPLACE VIEW public.panini_serial_premiums WITH (security_invoker = on) AS <that body>);
--   SELECT cron.unschedule('panini-serial-premiums');
--   DROP FUNCTION public.refresh_panini_serial_premiums(); DROP MATERIALIZED VIEW public.mv_panini_serial_premiums;

DO $premise$
BEGIN
  IF md5(pg_get_viewdef('public.panini_serial_premiums'::regclass)) <> '0bb5d9fa96320274898af8cb2a6476bb' THEN
    RAISE EXCEPTION 'panini_serial_premiums changed since 2026-11-23 read; re-read before applying';
  END IF;
END
$premise$;

CREATE MATERIALIZED VIEW public.mv_panini_serial_premiums AS
 WITH s AS (
         SELECT ps.sku,
            ps.edition_external_id,
            ps.amount_usd,
            ps.sold_at,
            ("substring"(ps.sku, '__([0-9]+)_[0-9]+$'::text))::integer AS serial_number,
            ("substring"(ps.sku, '__[0-9]+_([0-9]+)$'::text))::integer AS mint_cap
           FROM public.panini_sales ps
          WHERE ((ps.sold_at >= (now() - '90 days'::interval)) AND (ps.amount_usd > (0)::numeric))
        ), typ AS (
         SELECT s_1.edition_external_id,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((s_1.amount_usd)::double precision)))::numeric AS median_usd,
            (count(*))::integer AS sales_n
           FROM s s_1
          WHERE ((s_1.serial_number <> 1) AND (s_1.serial_number <> s_1.mint_cap))
          GROUP BY s_1.edition_external_id
         HAVING (count(*) >= 3)
        )
 SELECT pe.product_set_id,
    p.name AS product_name,
    p.last_grid_sport AS sport,
    pe.player_name,
    pe.set_name AS parallel,
    pe.thumbnail_url,
    s.edition_external_id AS external_id,
    s.sku,
    s.serial_number,
    s.mint_cap,
        CASE
            WHEN (s.serial_number = 1) THEN 'number 1'::text
            ELSE 'perfect mint'::text
        END AS headline,
    s.amount_usd AS sale_usd,
    s.sold_at,
    round(t.median_usd, 2) AS edition_median_usd,
    t.sales_n AS edition_sales_n,
    round((s.amount_usd / NULLIF(t.median_usd, (0)::numeric)), 1) AS premium_mult,
    now() AS computed_at
   FROM (((s
     JOIN typ t ON ((t.edition_external_id = s.edition_external_id)))
     JOIN public.panini_editions pe ON ((pe.external_id = s.edition_external_id)))
     LEFT JOIN public.panini_products p ON ((p.set_id = pe.product_set_id)))
  WHERE (((s.serial_number = 1) OR ((s.serial_number = s.mint_cap) AND (s.mint_cap > 1))) AND (t.median_usd > (0)::numeric) AND (s.amount_usd >= ((2)::numeric * t.median_usd)));

CREATE UNIQUE INDEX mv_panini_serial_premiums_pk ON public.mv_panini_serial_premiums USING btree (sku, sold_at);
CREATE INDEX mv_panini_serial_premiums_premium ON public.mv_panini_serial_premiums USING btree (premium_mult DESC, sku, sold_at DESC);

REVOKE ALL ON public.mv_panini_serial_premiums FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_panini_serial_premiums TO service_role;

CREATE OR REPLACE VIEW public.panini_serial_premiums WITH (security_invoker = on) AS
 SELECT m.product_set_id,
    m.product_name,
    m.sport,
    m.player_name,
    m.parallel,
    m.thumbnail_url,
    m.external_id,
    m.sku,
    m.serial_number,
    m.mint_cap,
    m.headline,
    m.sale_usd,
    m.sold_at,
    m.edition_median_usd,
    m.edition_sales_n,
    m.premium_mult
   FROM public.mv_panini_serial_premiums m;

CREATE OR REPLACE FUNCTION public.refresh_panini_serial_premiums()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_serial_premiums;
  SELECT count(*) INTO v_rows FROM public.mv_panini_serial_premiums;
  PERFORM public.log_pipeline_run('panini-serial-premiums', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-serial-premiums', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_panini_serial_premiums() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_serial_premiums() TO service_role;

SELECT cron.schedule('panini-serial-premiums', '20 * * * *', 'SELECT public.refresh_panini_serial_premiums()');

COMMENT ON MATERIALIZED VIEW public.mv_panini_serial_premiums IS
  'Panini #1 / perfect-mint sales at >= 2x the edition''s 90-day median (2026-11-23; the body panini_serial_premiums used to run per read). Hourly at :20 via refresh_panini_serial_premiums(); panini_serial_premiums is a thin view over it.';
