-- Materialise the first-mint trophies board. ONE MV fixes BOTH failing views:
-- topshot_first_mint_trophy_stats reads topshot_first_mint_trophies (verified via
-- pg_depend), so rebodying the latter makes the former fast for free.
--
-- Read rates and saving at 3 refreshes/h:
--   topshot_first_mint_trophy_stats  6.08/h, 52 MB/call, 80 GB/window -> 51%
--   topshot_first_mint_trophies      5.95/h, 52 MB/call, 78 GB/window -> 50%
-- Both mean ~13,050 ms against the service_role 30s wall; the board failed 56.8% of
-- 516 warm ticks / 48h.
DO $mig$
DECLARE v_def text;
BEGIN
  SELECT pg_get_viewdef('public.topshot_first_mint_trophies'::regclass, true) INTO v_def;
  IF v_def IS NULL OR length(v_def) < 300 THEN
    RAISE EXCEPTION 'refusing to build from an unexpected viewdef (len %)', coalesce(length(v_def), -1);
  END IF;
  EXECUTE 'CREATE MATERIALIZED VIEW public.mv_topshot_first_mint_trophies AS ' || v_def;
END
$mig$;
