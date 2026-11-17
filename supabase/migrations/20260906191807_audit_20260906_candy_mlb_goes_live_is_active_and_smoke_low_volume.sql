-- audit_20260906_candy_mlb_goes_live_is_active_and_smoke_low_volume
--
-- Candy MLB goes LIVE (thin — the overview tab only), Trevor's delegated
-- decision, go-live-2026-09.md §4. The code flip (`published: true`,
-- `pages: ["overview"]`, the Flow-only fan-out filters, the proxy root) ships
-- in the same push; this is the DB half, applied LAST per the readiness audit:
--
--   1. `collections.is_active = true` for candy_mlb — governs the anon RLS reads
--      on collections/editions/sets/players and ~13 cross-collection rollups
--      (get_platform_stats, get_market_summary, health_check, readiness,
--      liquidity/tier pulse, deal-alert defaults, catalog search). Candy's
--      shared-schema plane is complete (125/125 editions priced, 6,842 sales,
--      25,375 cached wallet Moments), so every rollup gains a REAL row, not a
--      row of zeros.
--   2. `analytics_smoke_run()` low-volume exclusion gains candy_mlb — its
--      max inter-sale gap over 14 d measured 16.4 h against the grader's 24 h
--      freshness threshold, i.e. a green launch that reds CI on a quiet Sunday.
--      Guarded splice (md5 asserted).
--
-- Revert: UPDATE collections SET is_active = false WHERE slug = 'candy_mlb';
-- re-apply analytics_smoke_run body md5 c78b81032ceddd41277d98dbb4ae1425.
-- `sets_summary` lags until refresh_sets_summary() (pg_cron jobid 37).

DO $splice$
DECLARE v_oid oid; v_def text; v_old text; v_new text; v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'analytics_smoke_run';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'analytics_smoke_run missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'c78b81032ceddd41277d98dbb4ae1425' THEN
    RAISE EXCEPTION 'analytics_smoke_run drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);
  v_old := $$ARRAY['ufc_strike', 'laliga_golazos']$$;
  v_new := $$ARRAY['ufc_strike', 'laliga_golazos', 'candy_mlb']$$;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor count %', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$splice$;

UPDATE public.collections SET is_active = true WHERE slug = 'candy_mlb' AND is_active = false;

DO $verify$
DECLARE v_n int; v jsonb;
BEGIN
  SELECT count(*) INTO v_n FROM public.collections WHERE is_active = true;
  IF v_n <> 6 THEN RAISE EXCEPTION 'expected 6 active collections, got %', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.collections WHERE slug = 'candy_mlb' AND is_active) THEN
    RAISE EXCEPTION 'candy_mlb not active';
  END IF;
  -- Positive control: a rollup that keys on is_active now carries Candy with REAL numbers.
  v := public.get_platform_stats();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v->'per_collection') c
     WHERE c->>'slug' = 'candy_mlb' AND (c->>'edition_count')::int >= 100
  ) THEN RAISE EXCEPTION 'get_platform_stats lacks a populated candy_mlb row: %', left(v::text, 300); END IF;
  RAISE NOTICE 'candy_mlb active; platform stats carry it';
END
$verify$;
