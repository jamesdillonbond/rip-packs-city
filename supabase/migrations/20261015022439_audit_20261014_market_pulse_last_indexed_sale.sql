-- Market Pulse: each collection carries the time of its last indexed sale
-- (2026-10-14 ~7:40 PM PT, Claude Code cloud; Trevor: "Keep going").
--
-- WHAT WAS WRONG. /insights/market-pulse renders a window with no indexed sales
-- as "Volume $0.00 · Sales 0 · Buyers 0". That is a market claim ("nobody
-- traded"), and on 10-14 it was false-by-coverage for Candy MLB: the Magic
-- Eden activities feed itself has shown nothing since 10-12 (newest activity
-- 2026-10-12 14:24 UTC, read live), while the OpenSea sales indexer is parked
-- until an OPENSEA_API_KEY exists (ledger 10-13). The page had no way to say
-- "the last sale we indexed was three days ago" instead of "$0".
--
-- WHAT CHANGES. `last_sale_at` (max sold_at over priced sales in the 30-day
-- scan the function already does; NULL when there is none in 30 days) is added
-- to both arms and to the output row. Nothing else moves: same filters, same
-- order, same grants. Applied as a guarded text splice over the live
-- definition (the 20260920175031 pattern), so no full-body transcription.
--
-- Revert: re-run the splice in reverse (drop the three inserted fragments);
-- the client treats a missing `last_sale_at` as unknown and renders as before.
DO $mig$
DECLARE
  d text;
  n int;
  c_win_md5 constant text := '40d5a107181744611531a7b30e188bf7';
  a1_old constant text := $a$AS top_sale_30d
    FROM public.sales s$a$;
  a1_new constant text := $a$AS top_sale_30d,
      max(s.sold_at) FILTER (WHERE s.price_usd > 0)                                                               AS last_sale_at
    FROM public.sales s$a$;
  a2_old constant text := $b$AS top_sale_30d
    FROM public.pinnacle_sales ps$b$;
  a2_new constant text := $b$AS top_sale_30d,
      max(ps.sold_at) FILTER (WHERE ps.sale_price_usd > 0)                                                         AS last_sale_at
    FROM public.pinnacle_sales ps$b$;
  a3_old constant text := $c$coalesce(a.buyers_30d,0) AS buyers_30d, a.top_sale_30d
$c$;
  a3_new constant text := $c$coalesce(a.buyers_30d,0) AS buyers_30d, a.top_sale_30d, a.last_sale_at
$c$;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'get_market_pulse_windows')
     IS DISTINCT FROM c_win_md5 THEN
    RAISE EXCEPTION 'get_market_pulse_windows changed since drafting (expected md5 %)', c_win_md5;
  END IF;

  d := pg_get_functiondef('public.get_market_pulse_windows()'::regprocedure);
  n := (length(d) - length(replace(d, a1_old, ''))) / length(a1_old);
  IF n <> 1 THEN RAISE EXCEPTION 'sales arm anchor: expected 1, found %', n; END IF;
  n := (length(d) - length(replace(d, a2_old, ''))) / length(a2_old);
  IF n <> 1 THEN RAISE EXCEPTION 'pinnacle arm anchor: expected 1, found %', n; END IF;
  n := (length(d) - length(replace(d, a3_old, ''))) / length(a3_old);
  IF n <> 1 THEN RAISE EXCEPTION 'output anchor: expected 1, found %', n; END IF;

  EXECUTE replace(replace(replace(d, a1_old, a1_new), a2_old, a2_new), a3_old, a3_new);

  IF (SELECT (length(p.prosrc) - length(replace(p.prosrc, 'last_sale_at', ''))) / length('last_sale_at')
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'get_market_pulse_windows') <> 3 THEN
    RAISE EXCEPTION 'post-flight: expected last_sale_at in both arms and the output';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'get_market_pulse_windows') IS NOT TRUE THEN
    RAISE EXCEPTION 'post-flight: SECURITY DEFINER lost';
  END IF;
  IF has_function_privilege('anon', 'public.get_market_pulse_windows()', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-flight: anon can execute get_market_pulse_windows';
  END IF;
END
$mig$;
