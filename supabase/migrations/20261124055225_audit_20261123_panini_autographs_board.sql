-- audit_20261123_panini_autographs_board
--
-- anon-exec: revoked (refresh_panini_autographs) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; postgres + service_role only.
--
-- 2026-11-23 (Claude Code cloud; Trevor: "Keep going" — Panini feature parity).
--
-- WHAT. A Panini leg for /insights/autographs (Top Shot + All Day only until now). Panini signs whole INSERTS, not one
-- parallel of a base card: every autograph card carries "Signature(s)" or "Autograph(s)" in its set name ("Rookie
-- Signatures", "Flawless Autographs Platinum", "Sensational Signatures Prizms Silver", …). Read 11-23: 1,992 of 56,621
-- catalogued editions match, every one with a shared `editions` row (absolute art); the distinct insert names were all
-- read by hand and every one is an autograph line. No serial-level autograph flag exists (panini_card_serials.nft_type
-- carries rookie / debut / #1 / perfect / jersey / challenge only), so the insert name IS the source.
--
-- Columns mirror v_insights_autographs so lib/insights/autographs-board.ts maps one shape. Market FACTS only, as on the
-- other legs — no FMV, no confidence:
--   low_ask     the cheapest listed serial re-read in the last 7 days (the same 7-day rule as the FMV ask cap)
--   sales_90d / median_90d / last sale   from panini_sales (own table; it lands 12–160 h after sold_at)
--   unsigned_*, premium_x   NULL by construction — a Panini autograph insert has no unsigned printing of the same card
--                           (its own card numbers), so a signed ÷ unsigned multiple would be a pairing RPC invented.
-- product_name / sport are extra columns for the row's subline (Panini cards carry no team).
--
-- COST (EXPLAIN ANALYZE 11-23, cold): 2.8 s, ~29k buffers (3.5k read) for 1,992 editions — paid once an hour at :48
-- by refresh_panini_autographs() (pg_cron 'panini-autographs', logs 'panini-autographs'); a board read is an index scan.
-- Also arms cadence watches for this lane and the two lanes added earlier tonight (panini-serial-premiums,
-- panini-rookie-board), so a dead refresh alarms instead of waiting 14 days for arm_unwatched_pipelines().
--
-- REVERT:
--   SELECT cron.unschedule('panini-autographs');
--   DROP FUNCTION public.refresh_panini_autographs(); DROP MATERIALIZED VIEW public.mv_panini_autographs;
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('panini-autographs','panini-serial-premiums','panini-rookie-board')
--     AND notes LIKE '%audit_20261123%';

CREATE MATERIALIZED VIEW public.mv_panini_autographs AS
 SELECT e.id::text AS edition_id,
    pe.external_id,
    'panini_blockchain'::text AS collection,
    pe.player_name,
    NULL::text AS team_name,
    pe.set_name,
    NULL::text AS parallel,
    pe.tier::text AS tier,
    NULL::integer AS series,
    pe.mint_cap AS circulation_count,
    e.thumbnail_url,
    a.low_ask,
    a.ask_seen_at,
    COALESCE(st.sales_90d, 0) AS sales_90d,
    round(st.median_90d::numeric, 2) AS median_90d,
    ls.amount_usd AS last_sale_usd,
    ls.sold_at AS last_sale_at,
    NULL::text AS unsigned_external_id,
    NULL::text AS unsigned_parallel,
    NULL::integer AS unsigned_circulation,
    NULL::integer AS unsigned_sales_90d,
    NULL::numeric AS unsigned_median_90d,
    NULL::numeric AS premium_x,
    p.name AS product_name,
    p.last_grid_sport AS sport,
    now() AS computed_at
   FROM public.panini_editions pe
     JOIN public.editions e ON e.external_id::text = pe.external_id AND e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
     LEFT JOIN public.panini_products p ON p.set_id = pe.product_set_id
     LEFT JOIN LATERAL (
       SELECT s.price_usd AS low_ask, s.captured_at AS ask_seen_at
         FROM public.panini_card_serials s
        WHERE s.edition_external_id = pe.external_id AND s.is_listed AND s.price_usd > 0
          AND s.captured_at > now() - interval '7 days'
        ORDER BY s.price_usd, s.captured_at DESC
        LIMIT 1
     ) a ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::integer AS sales_90d,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (x.amount_usd)::double precision) AS median_90d
         FROM public.panini_sales x
        WHERE x.edition_external_id = pe.external_id AND x.amount_usd > 0 AND x.sold_at > now() - interval '90 days'
     ) st ON true
     LEFT JOIN LATERAL (
       SELECT y.amount_usd, y.sold_at
         FROM public.panini_sales y
        WHERE y.edition_external_id = pe.external_id AND y.amount_usd > 0
        ORDER BY y.sold_at DESC
        LIMIT 1
     ) ls ON true
  WHERE pe.set_name ~* '(signature|autograph)';

CREATE UNIQUE INDEX mv_panini_autographs_pk ON public.mv_panini_autographs USING btree (edition_id);
CREATE INDEX mv_panini_autographs_ask ON public.mv_panini_autographs USING btree (low_ask, edition_id) WHERE low_ask IS NOT NULL;

REVOKE ALL ON public.mv_panini_autographs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_panini_autographs TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_panini_autographs()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_autographs;
  SELECT count(*) INTO v_rows FROM public.mv_panini_autographs;
  PERFORM public.log_pipeline_run('panini-autographs', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-autographs', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261123', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_panini_autographs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_autographs() TO service_role;

SELECT cron.schedule('panini-autographs', '48 * * * *', 'SELECT public.refresh_panini_autographs()');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES
  ('panini-autographs', 120, 'info', 'pg_cron 48 * * * * (hourly). refresh_panini_autographs — the Panini leg of /insights/autographs. audit_20261123.', true, 180),
  ('panini-serial-premiums', 120, 'info', 'pg_cron 20 * * * * (hourly). refresh_panini_serial_premiums — the #1 / perfect-mint half of /insights/panini-premiums. audit_20261123.', true, 180),
  ('panini-rookie-board', 1560, 'info', 'pg_cron 21 12 * * * (daily). refresh_panini_rookie_board — the Rookie cards tab on /insights/panini-squeeze. audit_20261123.', true, 2940)
ON CONFLICT (pipeline) DO NOTHING;

COMMENT ON MATERIALIZED VIEW public.mv_panini_autographs IS
  'Panini autograph editions (insert name carries Signature(s)/Autograph(s)) with market facts: 7-day confirmed low ask, 90-day sales + median, last sale. No unsigned pairing (Panini autos are their own inserts). Hourly at :48 via refresh_panini_autographs(). 2026-11-23.';
