-- Materialise the cross-collection deals board.
--
-- WHY: measured 2026-08-22, its Top Shot arm (topshot_deals_vs_fmv) alone reads
-- 29,146 buffers / 228 MB in 10.5s to return TWELVE rows — 85% of it a per-edition
-- latest-FMV subquery run 6,211 times whose confidence filter is applied AFTER the
-- per-edition LIMIT 1, so most lookups are paid for and discarded. Against
-- service_role's 30s statement_timeout the `deals` board failed 74.8% of its warm
-- attempts over 516 ticks / 48h, and every failure was a full-price read storing
-- nothing. 172 rows out; the whole input scanned every time. That is a query to
-- precompute, not to tune.
--
-- The body is taken from pg_get_viewdef() rather than transcribed, so the MV is
-- definitionally identical to the view it replaces — no chance of a silent drift
-- between the two during the swap.
DO $mig$
DECLARE v_def text;
BEGIN
  SELECT pg_get_viewdef('public.cross_collection_deals_board'::regclass, true) INTO v_def;
  IF v_def IS NULL OR length(v_def) < 500 THEN
    RAISE EXCEPTION 'refusing to build from an unexpected viewdef (len %)', coalesce(length(v_def), -1);
  END IF;
  EXECUTE 'CREATE MATERIALIZED VIEW public.mv_cross_collection_deals AS ' || v_def;
END
$mig$;
