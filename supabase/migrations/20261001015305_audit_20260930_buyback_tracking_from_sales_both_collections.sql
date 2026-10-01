-- audit_20260930_buyback_tracking_from_sales_both_collections
-- anon-exec: revoked (refresh_buyback_sales_daily) — NEW SECDEF fn; REVOKE FROM PUBLIC, anon, authenticated in one statement below, asserted with has_function_privilege.
-- anon-exec: revoked (rpc_buyback_analytics) — NEW SECDEF fn; REVOKE FROM PUBLIC, anon, authenticated in one statement below, asserted with has_function_privilege.
--
-- Trevor, 2026-09-30 (register #161): "Buybacks should still count as market sales on both, but
-- should be tracked additionally." Buybacks STAY in `sales` (nothing here filters them out); this
-- adds the ADDITIONAL tracking, for Top Shot AND All Day, from the one complete source: `sales`.
--
-- WHY NOT EXTEND THE EXISTING TOP SHOT BOARD: `rpc_topshot_buyback_analytics` reads
-- `topshot_buyback_daily`, an MV over `topshot_insider_buybacks`, which only sees purchases that
-- arrived through a 2026 insert trigger. Measured 2026-09-30: it publishes "all time" as 2,968
-- purchases / $73k since 2026-01-20, while `sales` holds 94,997 priced purchases by the same two
-- wallets ($2.63M since 2022), 60,409 of them in 2026 — every backfilled source
-- (ts_history_backfill_v1 44,931, onchain 6,519, topshot_marketplace 2,378, …) is invisible to it.
-- That board is left in place, unread once the route moves to this RPC.
--
-- OBJECTS
--   buyback_wallets          registry: which wallet is a buyback buyer, per collection
--   buyback_sales_daily      MV over `sales` joined to the registry (1.4 s, 47k buffers, ~128k rows)
--   refresh_buyback_sales_daily()   REFRESH CONCURRENTLY + pipeline_runs row
--   rpc_buyback_analytics(collection, period, limit)  same payload shape as the Top Shot RPC
--   pg_cron 'rpc-refresh-buyback-sales-daily' 53 8 * * * (2 min after job 333)
--
-- ⛔ An unknown collection slug is REFUSED (22023), never defaulted: answering for a different
-- collection under the requested one's name is the substitution class (CLAUDE.md).
--
-- REVERT:
--   SELECT cron.unschedule('rpc-refresh-buyback-sales-daily');
--   DROP FUNCTION public.rpc_buyback_analytics(text, text, integer);
--   DROP FUNCTION public.refresh_buyback_sales_daily();
--   DROP MATERIALIZED VIEW public.buyback_sales_daily;
--   DROP TABLE public.buyback_wallets;

CREATE TABLE IF NOT EXISTS public.buyback_wallets (
  collection_id uuid NOT NULL REFERENCES public.collections(id),
  wallet_address text NOT NULL CHECK (wallet_address = lower(wallet_address) AND wallet_address LIKE '0x%'),
  label text NOT NULL,
  evidence text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, wallet_address)
);
ALTER TABLE public.buyback_wallets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyback_wallets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.buyback_wallets TO service_role;

INSERT INTO public.buyback_wallets (collection_id, wallet_address, label, evidence) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '0xe1f2a091f7bb5245', 'TopShot_Buyback_2',
   'seeded_wallets tag secondary_buyback; marketplace buyer of record'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '0x4d2c9216f1dca098', 'NBATopShotCommunity',
   'seeded_wallets tag secondary_buyback'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '0xe4cf4bdc1751c65d', 'AllDay issuer (pack buybacks)',
   'register #161: 19/20 + 14/14 sampled txs run Dapper''s "Fulfills a pack buyback offer" script; the moment is deposited into this account''s own collection')
ON CONFLICT DO NOTHING;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.buyback_sales_daily AS
SELECT s.collection_id,
       s.buyer_address,
       (s.sold_at AT TIME ZONE 'UTC')::date                     AS activity_date,
       s.edition_id,
       NULLIF(s.seller_address, '')                             AS seller_address,
       count(*)::integer                                        AS purchases,
       (count(*) FILTER (WHERE s.price_usd > 0))::integer        AS priced_purchases,
       sum(s.price_usd) FILTER (WHERE s.price_usd > 0)          AS spend_usd
FROM public.sales s
JOIN public.buyback_wallets w
  ON w.collection_id = s.collection_id
 AND w.wallet_address = s.buyer_address
GROUP BY 1, 2, 3, 4, 5;

CREATE UNIQUE INDEX IF NOT EXISTS buyback_sales_daily_key
  ON public.buyback_sales_daily (collection_id, buyer_address, activity_date, edition_id, seller_address)
  NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS buyback_sales_daily_coll_date
  ON public.buyback_sales_daily (collection_id, activity_date);
REVOKE ALL ON public.buyback_sales_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.buyback_sales_daily TO service_role;

CREATE FUNCTION public.refresh_buyback_sales_daily()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows int;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.buyback_sales_daily;
  SELECT count(*) INTO v_rows FROM public.buyback_sales_daily;
  PERFORM public.log_pipeline_run(
    p_pipeline := 'refresh-buyback-sales-daily', p_started_at := v_started,
    p_rows_found := v_rows, p_rows_written := v_rows, p_rows_skipped := 0,
    p_ok := true, p_error := NULL, p_collection_slug := NULL,
    p_cursor_before := NULL, p_cursor_after := NULL,
    p_extra := jsonb_build_object('duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run(
    p_pipeline := 'refresh-buyback-sales-daily', p_started_at := v_started,
    p_rows_found := NULL, p_rows_written := NULL, p_rows_skipped := NULL,
    p_ok := false, p_error := left(SQLERRM, 300), p_collection_slug := NULL,
    p_cursor_before := NULL, p_cursor_after := NULL, p_extra := NULL);
  RAISE;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.refresh_buyback_sales_daily() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_buyback_sales_daily() TO postgres, service_role;

CREATE FUNCTION public.rpc_buyback_analytics(p_collection text, p_period text DEFAULT 'month', p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today  date := (now() AT TIME ZONE 'UTC')::date;
  v_coll   uuid;
  v_start  date;
  v_obs    date;
  v_limit  int  := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_result jsonb;
BEGIN
  IF p_period IS NULL OR p_period NOT IN ('week', 'month', 'year', 'all') THEN
    RAISE EXCEPTION 'invalid period %, expected week|month|year|all', p_period USING ERRCODE = '22023';
  END IF;
  SELECT c.id INTO v_coll FROM public.collections c
   WHERE c.slug = p_collection
     AND EXISTS (SELECT 1 FROM public.buyback_wallets w WHERE w.collection_id = c.id);
  IF v_coll IS NULL THEN
    RAISE EXCEPTION 'no buyback tracking for collection %', p_collection USING ERRCODE = '22023';
  END IF;

  SELECT min(d.activity_date) INTO v_obs FROM public.buyback_sales_daily d WHERE d.collection_id = v_coll;
  v_start := CASE p_period
    WHEN 'week'  THEN date_trunc('week',  v_today)::date
    WHEN 'month' THEN date_trunc('month', v_today)::date
    WHEN 'year'  THEN date_trunc('year',  v_today)::date
    ELSE v_obs
  END;

  WITH scope AS (
    SELECT d.*, w.label
    FROM public.buyback_sales_daily d
    JOIN public.buyback_wallets w ON w.collection_id = d.collection_id AND w.wallet_address = d.buyer_address
    WHERE d.collection_id = v_coll AND d.activity_date >= v_start AND d.activity_date <= v_today
  ),
  totals AS (
    SELECT coalesce(sum(purchases), 0)::bigint        AS purchases,
           coalesce(sum(priced_purchases), 0)::bigint AS priced_purchases,
           sum(spend_usd)                             AS spend_usd,
           count(DISTINCT edition_id)                 AS distinct_editions,
           count(DISTINCT activity_date)              AS active_days,
           (count(*) FILTER (WHERE seller_address IS NOT NULL))::bigint AS seller_rows,
           coalesce(sum(purchases) FILTER (WHERE seller_address IS NOT NULL), 0)::bigint AS seller_known
    FROM scope
  ),
  by_wallet AS (
    SELECT jsonb_agg(w ORDER BY w.purchases DESC) AS j
    FROM (SELECT s.buyer_address AS address, max(s.label) AS username,
                 sum(s.purchases)::bigint AS purchases, sum(s.priced_purchases)::bigint AS priced_acquisitions,
                 sum(s.spend_usd) AS spend_usd, count(DISTINCT s.edition_id) AS distinct_editions,
                 (sum(s.priced_purchases) > 0) AS spend_known
          FROM scope s GROUP BY s.buyer_address) w
  ),
  top_ed_count AS (
    SELECT jsonb_agg(e ORDER BY e.purchases DESC) AS j
    FROM (SELECT s.edition_id, max(ed.player_name) AS player_name, max(ed.set_name) AS set_name,
                 max(ed.tier::text) AS tier, max(ed.series) AS series,
                 sum(s.purchases)::bigint AS purchases, sum(s.priced_purchases)::bigint AS priced_acquisitions,
                 sum(s.spend_usd) AS spend_usd
          FROM scope s JOIN public.editions ed ON ed.id = s.edition_id
          WHERE s.edition_id IS NOT NULL
          GROUP BY s.edition_id
          ORDER BY sum(s.purchases) DESC, sum(s.spend_usd) DESC NULLS LAST
          LIMIT v_limit) e
  ),
  top_ed_spend AS (
    SELECT jsonb_agg(e ORDER BY e.spend_usd DESC) AS j
    FROM (SELECT s.edition_id, max(ed.player_name) AS player_name, max(ed.set_name) AS set_name,
                 max(ed.tier::text) AS tier, sum(s.priced_purchases)::bigint AS priced_acquisitions,
                 sum(s.spend_usd) AS spend_usd
          FROM scope s JOIN public.editions ed ON ed.id = s.edition_id
          WHERE s.edition_id IS NOT NULL AND s.priced_purchases > 0
          GROUP BY s.edition_id
          ORDER BY sum(s.spend_usd) DESC NULLS LAST
          LIMIT v_limit) e
  ),
  sellers AS (
    SELECT s.seller_address, max(u.username) AS username,
           sum(s.purchases)::bigint AS purchases, sum(s.spend_usd) AS spend_usd
    FROM scope s
    LEFT JOIN public.wallet_usernames u ON lower(u.wallet_addr) = lower(s.seller_address)
    WHERE s.seller_address IS NOT NULL
    GROUP BY s.seller_address
  ),
  top_sell_spend AS (
    SELECT jsonb_agg(x ORDER BY x.spend_usd DESC NULLS LAST) AS j
    FROM (SELECT * FROM sellers ORDER BY spend_usd DESC NULLS LAST LIMIT v_limit) x
  ),
  top_sell_count AS (
    SELECT jsonb_agg(x ORDER BY x.purchases DESC) AS j
    FROM (SELECT * FROM sellers ORDER BY purchases DESC LIMIT v_limit) x
  ),
  timeline AS (
    SELECT jsonb_agg(t ORDER BY t.d) AS j
    FROM (SELECT s.activity_date AS d, sum(s.purchases)::bigint AS purchases,
                 sum(s.priced_purchases)::bigint AS priced_acquisitions, sum(s.spend_usd) AS spend_usd
          FROM scope s GROUP BY s.activity_date) t
  )
  SELECT jsonb_build_object(
    'collection',   p_collection,
    'period',       p_period,
    'window_start', v_start,
    'window_end',   v_today,
    'basis',        'sales',
    'totals', jsonb_build_object(
      'purchases',         t.purchases,
      'priced_purchases',  t.priced_purchases,
      'spend_usd',         t.spend_usd,
      'spend_known',       (t.priced_purchases > 0),
      'distinct_editions', t.distinct_editions,
      'active_days',       t.active_days),
    'coverage', jsonb_build_object(
      'observation_start',      v_obs,
      'unpriced_purchases',     t.purchases - t.priced_purchases,
      'counterparty_known_for', t.seller_known,
      'date_grain',             'day',
      'excluded_snapshot_rows', 0,
      'excluded_wallets',       0,
      'excluded_reason',        NULL),
    'wallets',               coalesce(bw.j,  '[]'::jsonb),
    'top_editions_by_count', coalesce(tec.j, '[]'::jsonb),
    'top_editions_by_spend', coalesce(tes.j, '[]'::jsonb),
    'top_sellers_by_spend',  coalesce(tss.j, '[]'::jsonb),
    'top_sellers_by_count',  coalesce(tsc.j, '[]'::jsonb),
    'timeline',              coalesce(tl.j,  '[]'::jsonb))
  INTO v_result
  FROM totals t, by_wallet bw, top_ed_count tec, top_ed_spend tes, top_sell_spend tss, top_sell_count tsc, timeline tl;

  RETURN v_result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_buyback_analytics(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_buyback_analytics(text, text, integer) TO service_role;

SELECT cron.schedule('rpc-refresh-buyback-sales-daily', '53 8 * * *', 'select public.refresh_buyback_sales_daily()');

DO $mig$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM (VALUES
    ('public.refresh_buyback_sales_daily()'),
    ('public.rpc_buyback_analytics(text, text, integer)')) f(sig)
  WHERE has_function_privilege('anon', f.sig, 'EXECUTE') OR has_function_privilege('authenticated', f.sig, 'EXECUTE');
  IF v_bad > 0 THEN RAISE EXCEPTION '% new function(s) still executable by anon/authenticated', v_bad; END IF;
  IF has_table_privilege('anon', 'public.buyback_sales_daily', 'SELECT') THEN
    RAISE EXCEPTION 'buyback_sales_daily readable by anon';
  END IF;
  IF (SELECT count(*) FROM public.buyback_sales_daily) = 0 THEN
    RAISE EXCEPTION 'buyback_sales_daily is empty; expected the registry wallets to match sales';
  END IF;
END
$mig$;
