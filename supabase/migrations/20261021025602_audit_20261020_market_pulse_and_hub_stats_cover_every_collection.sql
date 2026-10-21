-- audit_20261020_market_pulse_and_hub_stats_cover_every_collection
--
-- 2026-10-20 ~8:15 PM PT (Claude Code cloud; Trevor: "work on roadmap items and
-- known issues"). Found by a read-only sweep of the live /insights boards.
--
-- WHAT WAS WRONG.
--  1. /insights/market-pulse says "every collection we track in one view", and
--     get_market_pulse_windows() had no Panini arm. Panini's `panini_sales` held
--     4,909 marketplace sales worth $96,007 in the 7 days to 10-20 evening, which
--     makes it the #2 collection by volume, and the board left it out.
--  2. The /insights hub's "Flow market pulse" strip (get_insights_hub_stats().market)
--     summed `sales` only. It left out Disney Pinnacle, a Flow collection
--     ($17.2K / 1,609 sales in 7 days, kept in `pinnacle_sales`), and it included
--     Candy MLB, which is on Solana. So the label was wrong in both directions,
--     and the hub total did not match the board it links to.
--
-- WHAT CHANGES. Both are guarded text splices over the live definition (the
-- 20260920175031 / 20261015022439 pattern: md5-pinned base, anchors counted).
--  - get_market_pulse_windows: a `pan` arm over panini_sales (amount_usd > 0;
--    buyer / seller are Panini usernames, counted as distinct strings like the
--    other arms' addresses), unioned into `agg`, and ('panini_blockchain','Panini')
--    added to `cols`. Nothing else moves.
--  - get_insights_hub_stats: `recent_sales` also unions pinnacle_sales
--    (sale_price_usd) and panini_sales (amount_usd), so the hub strip is the sum
--    of the board's rows. The app relabels the strip "Market pulse".
--
-- anon-exec: unchanged (get_market_pulse_windows) — CREATE OR REPLACE of the same signature keeps its ACL (service_role only).
-- anon-exec: unchanged (get_insights_hub_stats) — CREATE OR REPLACE of the same signature keeps its ACL (service_role only).
--
-- REVERT: re-run the splices in reverse (remove the inserted fragments); the
-- md5 of each pre-change body is pinned below.
DO $mig$
DECLARE
  d text;
  n int;
  c_pulse_md5 constant text := '304e18eded18cd0f3c0f6f59a6f98a06';
  c_hub_md5   constant text := '50e003ee597b40fcc2c8961fca68c2ca';
  p1_old constant text := $a$  agg AS (SELECT * FROM main UNION ALL SELECT * FROM pin),$a$;
  p1_new constant text := $a$  pan AS (
    SELECT 'panini_blockchain'::text AS slug,
      count(*) FILTER (WHERE pn.sold_at > now()-interval '24 hours' AND pn.amount_usd > 0)                        AS sales_24h,
      round(coalesce(sum(pn.amount_usd) FILTER (WHERE pn.sold_at > now()-interval '24 hours' AND pn.amount_usd > 0),0)::numeric,2) AS volume_24h,
      count(DISTINCT pn.buyer) FILTER (WHERE pn.sold_at > now()-interval '24 hours' AND pn.amount_usd > 0)        AS buyers_24h,
      max(pn.amount_usd) FILTER (WHERE pn.sold_at > now()-interval '24 hours' AND pn.amount_usd > 0)              AS top_sale_24h,
      count(*) FILTER (WHERE pn.sold_at > now()-interval '7 days' AND pn.amount_usd > 0)                          AS sales_7d,
      round(coalesce(sum(pn.amount_usd) FILTER (WHERE pn.sold_at > now()-interval '7 days' AND pn.amount_usd > 0),0)::numeric,2) AS volume_7d,
      count(DISTINCT pn.buyer) FILTER (WHERE pn.sold_at > now()-interval '7 days' AND pn.amount_usd > 0)          AS buyers_7d,
      count(DISTINCT pn.seller) FILTER (WHERE pn.sold_at > now()-interval '7 days' AND pn.amount_usd > 0)         AS sellers_7d,
      max(pn.amount_usd) FILTER (WHERE pn.sold_at > now()-interval '7 days' AND pn.amount_usd > 0)                AS top_sale_7d,
      count(*) FILTER (WHERE pn.sold_at > now()-interval '30 days' AND pn.amount_usd > 0)                         AS sales_30d,
      round(coalesce(sum(pn.amount_usd) FILTER (WHERE pn.sold_at > now()-interval '30 days' AND pn.amount_usd > 0),0)::numeric,2) AS volume_30d,
      count(DISTINCT pn.buyer) FILTER (WHERE pn.sold_at > now()-interval '30 days' AND pn.amount_usd > 0)         AS buyers_30d,
      max(pn.amount_usd) FILTER (WHERE pn.sold_at > now()-interval '30 days' AND pn.amount_usd > 0)               AS top_sale_30d,
      max(pn.sold_at) FILTER (WHERE pn.amount_usd > 0)                                                             AS last_sale_at
    FROM public.panini_sales pn
    WHERE pn.sold_at > now()-interval '30 days'
  ),
  agg AS (SELECT * FROM main UNION ALL SELECT * FROM pin UNION ALL SELECT * FROM pan),$a$;
  p2_old constant text := $b$('candy_mlb','Candy MLB')
  )$b$;
  p2_new constant text := $b$('candy_mlb','Candy MLB'),('panini_blockchain','Panini')
  )$b$;
  h1_old constant text := $c$    SELECT sold_at, price_usd
    FROM sales
    WHERE sold_at >= now() - interval '7 days'
      AND price_usd > 0
  )$c$;
  h1_new constant text := $c$    SELECT sold_at, price_usd
    FROM sales
    WHERE sold_at >= now() - interval '7 days'
      AND price_usd > 0
    UNION ALL
    SELECT sold_at, sale_price_usd
    FROM pinnacle_sales
    WHERE sold_at >= now() - interval '7 days'
      AND sale_price_usd > 0
    UNION ALL
    SELECT sold_at, amount_usd
    FROM panini_sales
    WHERE sold_at >= now() - interval '7 days'
      AND amount_usd > 0
  )$c$;
BEGIN
  -- ── get_market_pulse_windows ──
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE oid = 'public.get_market_pulse_windows()'::regprocedure;
  IF d <> c_pulse_md5 THEN RAISE EXCEPTION 'get_market_pulse_windows body moved (md5 %), re-read before splicing', d; END IF;
  d := pg_get_functiondef('public.get_market_pulse_windows()'::regprocedure);
  n := (length(d) - length(replace(d, p1_old, ''))) / length(p1_old);
  IF n <> 1 THEN RAISE EXCEPTION 'pulse agg anchor found % times, want 1', n; END IF;
  d := replace(d, p1_old, p1_new);
  n := (length(d) - length(replace(d, p2_old, ''))) / length(p2_old);
  IF n <> 1 THEN RAISE EXCEPTION 'pulse cols anchor found % times, want 1', n; END IF;
  d := replace(d, p2_old, p2_new);
  EXECUTE d;

  -- ── get_insights_hub_stats ──
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE oid = 'public.get_insights_hub_stats()'::regprocedure;
  IF d <> c_hub_md5 THEN RAISE EXCEPTION 'get_insights_hub_stats body moved (md5 %), re-read before splicing', d; END IF;
  d := pg_get_functiondef('public.get_insights_hub_stats()'::regprocedure);
  n := (length(d) - length(replace(d, h1_old, ''))) / length(h1_old);
  IF n <> 1 THEN RAISE EXCEPTION 'hub recent_sales anchor found % times, want 1', n; END IF;
  d := replace(d, h1_old, h1_new);
  EXECUTE d;
END
$mig$;
