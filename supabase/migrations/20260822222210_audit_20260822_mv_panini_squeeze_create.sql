-- Materialise the Panini WC Prizm squeeze board — the single largest board consumer.
--
-- WHY, and why this is a BIGGER win than the deals board shipped an hour earlier:
-- read rate decides whether materialising pays, and panini's is 5.3x deals'.
--   panini_squeeze_board   20.50 reads/h, 71 MB/call, 372 GB/window -> 85% saved at 3 refreshes/h
--   cross_collection_deals  3.84 reads/h, 78 MB/call,  76 GB/window -> 22% saved
-- ⚠ I FILED THE OPPOSITE EARLIER TODAY — "panini's break-even is completely different and
-- copying would very likely be read-negative". Backwards: a HIGHER read rate means MORE
-- benefit, because the refresh rate is fixed and it is the reads it replaces that scale.
--
-- Its warm also failed 76.0% of 516 ticks / 48h at the service_role 30s wall, and its fetch
-- is PAGED (errors labelled `page 0`/`page 1`), so one warm issues several 30s-capable
-- statements — which is why its call count exceeds the tick count. panini_card_serials is
-- separately the #3 seq-scanned table at 8,848 scans x 138 MB = 1.19 TB.
--
-- ⚠ No is_active guard here, unlike the deals board. Verified rather than assumed: this
-- board reads only panini_card_serials / panini_editions / panini_fmv_snapshots /
-- panini_coverage_audit — none RLS-row-filtered the way `editions` is — and the view is
-- already anon-SELECT false, so there is no anon path whose semantics an MV could widen.
DO $mig$
DECLARE v_def text;
BEGIN
  SELECT pg_get_viewdef('public.panini_squeeze_board'::regclass, true) INTO v_def;
  IF v_def IS NULL OR length(v_def) < 300 THEN
    RAISE EXCEPTION 'refusing to build from an unexpected viewdef (len %)', coalesce(length(v_def), -1);
  END IF;
  EXECUTE 'CREATE MATERIALIZED VIEW public.mv_panini_squeeze AS ' || v_def;
END
$mig$;
