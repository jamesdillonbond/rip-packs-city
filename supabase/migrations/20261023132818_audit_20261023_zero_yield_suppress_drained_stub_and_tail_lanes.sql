-- audit_20261023_zero_yield_suppress_drained_stub_and_tail_lanes
--
-- 2026-10-23 (PT, Claude Code cloud; the 10-23 overnight handoff's queued item 4: "Characterize the
-- 5 zero-yield lanes; suppress/retire the drained ones"). Characterized ~6:25 AM PT, one positive
-- control per lane. Suppresses THREE; the other two are deliberately left alone:
--
--   resolve-topshot-stubs + topshot-stub-resolver (one lane, two names: the cron route and the edge
--   fn it calls) — DRAINED. Their own RPC get_topshot_stub_targets(50) returns 0. The WHOLE
--   population (Top Shot editions missing player / set / tier) is 1 edition, and it is resting after
--   a 10-02 chain check (eligible again 11-01). Positive control: none of the 17 Series 9 editions
--   minted 10-21..10-22 is incomplete, so new editions arrive named and never become stubs.
--   allday-unmapped-resolver-tail — DRAINED, with a live control: unmapped_sales holds 871 All Day rows,
--   ALL resolved, all within the last 7 days, the newest sold 6:15 AM PT and resolved 6:20 AM PT by
--   the live resolver. The tail (> 7 d old, unresolved, priced) is 0 because the live path clears
--   every new row before it can age into it.
--
-- NOT suppressed:
--   ufc-enrichment-drain — retired 10-18 (cron-job.org disabled). It flags on 125 runs in the 7-day
--   pipeline_runs_daily window, all from before the retirement; it falls under the 50-run floor and
--   leaves the list by itself around 10-25. A suppression would outlive the lane.
--   candy-sales-indexer — known #58 (OpenSea key). It stays visible on purpose until the key exists.
--
-- Each premise is re-asserted at apply time; a false one aborts the migration.
--
-- REVERT: DELETE FROM public.pipeline_zero_yield_suppressions
--         WHERE pipeline IN ('resolve-topshot-stubs','topshot-stub-resolver','allday-unmapped-resolver-tail');

DO $mig$
DECLARE v_stub_targets bigint; v_tail bigint; v_resolved_7d bigint;
BEGIN
  SELECT count(*) INTO v_stub_targets FROM public.get_topshot_stub_targets(50);
  IF v_stub_targets > 0 THEN
    RAISE EXCEPTION 'premise false: get_topshot_stub_targets returns % targets', v_stub_targets;
  END IF;

  SELECT count(*) INTO v_tail
    FROM public.unmapped_sales
   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND resolved_at IS NULL AND price_usd > 0 AND sold_at < now() - interval '7 days';
  IF v_tail > 0 THEN
    RAISE EXCEPTION 'premise false: % unresolved priced All Day tail rows', v_tail;
  END IF;

  -- positive control: the live path is resolving All Day rows, so a zero tail is a drained one
  SELECT count(*) INTO v_resolved_7d
    FROM public.unmapped_sales
   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND resolved_at > now() - interval '7 days';
  IF v_resolved_7d = 0 THEN
    RAISE EXCEPTION 'premise false: no All Day unmapped row resolved in 7 days (control failed)';
  END IF;
END
$mig$;

INSERT INTO public.pipeline_zero_yield_suppressions (pipeline, reason, added_by) VALUES
('resolve-topshot-stubs',
 'DRAINED, measured 2026-10-23 ~6:25 AM PT. Cron route for topshot-stub-resolver (same lane). get_topshot_stub_targets(50) = 0; the whole population (Top Shot editions missing player / set / tier) is 1 edition, resting after a 10-02 chain check (eligible 11-01). Positive control: 0 of the 17 Series 9 editions minted 10-21..10-22 are incomplete, so new editions arrive named. RE-CHECK CONDITION: remove this row if get_topshot_stub_targets returns rows while rows_found stays 0, or if new editions start arriving incomplete.',
 'claude-code-cloud session_01W7x9yCaphqxBSZRbsFKLqa'),
('topshot-stub-resolver',
 'DRAINED, measured 2026-10-23 ~6:25 AM PT. Same lane as resolve-topshot-stubs (this is the edge fn; extra.message = "no stub targets"). get_topshot_stub_targets(50) = 0; 1 incomplete Top Shot edition in the catalog, resting until 11-01. RE-CHECK CONDITION: as resolve-topshot-stubs.',
 'claude-code-cloud session_01W7x9yCaphqxBSZRbsFKLqa'),
('allday-unmapped-resolver-tail',
 'DRAINED, measured 2026-10-23 ~6:25 AM PT. The tail (All Day unmapped_sales unresolved, priced, sold > 7 d ago) = 0; both window arms (never attempted / attempted > 14 d ago) = 0. Positive control: 871 All Day unmapped rows, ALL resolved within 7 days by the live resolver — the newest sold 6:15 AM PT, resolved 6:20 AM PT — so new rows never age into the tail. RE-CHECK CONDITION: remove this row if any unresolved priced All Day row older than 7 days appears while rows_found stays 0.',
 'claude-code-cloud session_01W7x9yCaphqxBSZRbsFKLqa')
ON CONFLICT (pipeline) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by;
