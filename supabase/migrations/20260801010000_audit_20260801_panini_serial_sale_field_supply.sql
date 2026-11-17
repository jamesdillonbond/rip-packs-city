-- audit_20260801_panini_serial_sale_field_supply
--
-- RECONSTRUCTED FROM LIVE `pg_get_viewdef` on 2026-07-31 (PT) by a later session.
-- The originating Cowork session applied this view via the Supabase MCP and never
-- committed a migration file, so the repo had no record of it. Captured here verbatim
-- as it existed in prod immediately BEFORE
-- `20260801013000_audit_20260801_panini_preserve_sale_fossils.sql` replaced it, so that
-- migration's documented revert path is actually executable.
--
-- Purpose: per-capture-day Panini serial sale-field supply. The shape deliberately
-- separates "upstream stopped sending" (pct_upstream_supplied collapses) from
-- "we stopped parsing" (mapping_shortfall > 0) — different owners, different fixes.

CREATE OR REPLACE VIEW public.v_panini_serial_sale_field_supply AS
SELECT captured_at::date AS capture_day,
       count(*) AS serials_captured,
       count(*) FILTER (WHERE NULLIF(NULLIF(raw ->> 'brought_at_price', ''), '0') IS NOT NULL) AS raw_supplied_sale_price,
       count(*) FILTER (WHERE NULLIF(raw ->> 'brought_at_time', '') IS NOT NULL) AS raw_supplied_sale_time,
       count(*) FILTER (WHERE last_sale_usd IS NOT NULL) AS column_last_sale_usd,
       round(100.0 * count(*) FILTER (WHERE NULLIF(NULLIF(raw ->> 'brought_at_price', ''), '0') IS NOT NULL)::numeric
             / NULLIF(count(*), 0)::numeric, 2) AS pct_upstream_supplied,
       count(*) FILTER (WHERE NULLIF(NULLIF(raw ->> 'brought_at_price', ''), '0') IS NOT NULL)
         - count(*) FILTER (WHERE last_sale_usd IS NOT NULL) AS mapping_shortfall
  FROM public.panini_card_serials s
 WHERE captured_at > (now() - '30 days'::interval)
 GROUP BY captured_at::date;

ALTER VIEW public.v_panini_serial_sale_field_supply SET (security_invoker = on);
REVOKE ALL ON public.v_panini_serial_sale_field_supply FROM anon, authenticated;
