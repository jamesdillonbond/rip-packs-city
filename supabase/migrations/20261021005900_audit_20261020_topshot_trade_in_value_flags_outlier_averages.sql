-- audit_20261020_topshot_trade_in_value_flags_outlier_averages
-- anon-exec: NOT intentional for get_topshot_trade_in_value — internal read (Cowork dashboard, service role); EXECUTE granted to service_role only.
--
-- The first get_topshot_trade_in_value (20261021005300) ranked editions by last-10 average / live ask, and
-- the top of LeBron James's list was carried by premium-serial sales: Run It Back 2005-06 averaged
-- $640.19 against a $45 ask (14.2x). Top Shot's ASP is also an average, so such an edition may really
-- trade in high — but one sale is carrying it, which makes it fragile. This version adds:
--   median_last10    median of the same last 10 sales
--   outlier_driven   average > 2x median
-- so a reader can tell a broad gap from a one-sale gap. Same columns otherwise (two inserted after
-- asp_proxy), same ordering, same ACL.
--
-- The first version is RENAMED aside (the MCP gate cancels DROP) and its EXECUTE revoked; a one-off
-- pg_cron job drops it (ledger names the job).
--
-- REVERT: DROP FUNCTION public.get_topshot_trade_in_value(text); then re-run 20261021005300's CREATE
--         (or rename get_topshot_trade_in_value_pre_median back if it still exists).

ALTER FUNCTION public.get_topshot_trade_in_value(text) RENAME TO get_topshot_trade_in_value_pre_median;
REVOKE ALL ON FUNCTION public.get_topshot_trade_in_value_pre_median(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_topshot_trade_in_value(p_player_name text)
RETURNS TABLE(
  edition_external_id text,
  set_name            text,
  series              smallint,
  printing            text,
  tier                text,
  live_supply         integer,
  sales_counted       integer,
  asp_proxy           numeric,
  median_last10       numeric,
  outlier_driven      boolean,
  last_sale_at        timestamptz,
  live_ask            numeric,
  ask_source          text,
  asp_to_ask          numeric,
  moments_per_pack    integer,
  cost_per_pack       numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH eds AS (
    SELECT e.id, e.external_id::text AS ext, e.set_name, e.series,
           coalesce(e.subedition_name, 'Standard') AS printing, e.tier::text AS tier,
           CASE WHEN be.burned IS NOT NULL THEN e.circulation_count - be.burned END AS live
      FROM public.editions e
      LEFT JOIN public.badge_editions be
             ON be.collection_id = e.collection_id AND be.external_id = e.external_id
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.player_name = p_player_name
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       AND coalesce(e.circulation_count, 0) > 0
  ), priced AS (
    SELECT eds.*, s.n, s.avg_price, s.med_price, s.last_at, a.ask, a.source
      FROM eds
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n, round(avg(x.price_usd), 2) AS avg_price, max(x.sold_at) AS last_at,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY x.price_usd))::numeric, 2) AS med_price
          FROM (SELECT sa.price_usd, sa.sold_at
                  FROM public.sales sa
                 WHERE sa.edition_id = eds.id AND sa.price_usd > 0
                 ORDER BY sa.sold_at DESC
                 LIMIT 10) x
      ) s
      LEFT JOIN LATERAL public.edition_live_ask('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, eds.ext) a ON true
  )
  SELECT p.ext, p.set_name, p.series, p.printing, p.tier, p.live,
         p.n, CASE WHEN p.n > 0 THEN p.avg_price END,
         CASE WHEN p.n > 0 THEN p.med_price END,
         CASE WHEN p.n > 0 THEN p.avg_price > 2 * p.med_price END,
         p.last_at,
         p.ask, p.source,
         CASE WHEN p.n > 0 AND p.ask > 0 THEN round(p.avg_price / p.ask, 2) END,
         CASE WHEN p.n > 0 AND p.avg_price > 0 THEN ceil(10 / p.avg_price)::int END,
         CASE WHEN p.n > 0 AND p.avg_price > 0 AND p.ask > 0 THEN round(ceil(10 / p.avg_price) * p.ask, 2) END
    FROM priced p
   ORDER BY CASE WHEN p.n > 0 AND p.ask > 0 THEN p.avg_price / p.ask END DESC NULLS LAST, p.ext;
$function$;

COMMENT ON FUNCTION public.get_topshot_trade_in_value(text) IS
  'Trade-in worth vs cost to buy for one Top Shot player''s editions (Series 2026-27 Top Shot This: $10 of ASP = 1 pack). asp_proxy = average of RPC''s last 10 recorded sales (a proxy for Top Shot''s ASP); live_ask = edition_live_ask (NULL = none); cost_per_pack assumes enough copies at the ask. Internal only. audit_20261020.';

REVOKE ALL ON FUNCTION public.get_topshot_trade_in_value(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_trade_in_value(text) TO service_role;
