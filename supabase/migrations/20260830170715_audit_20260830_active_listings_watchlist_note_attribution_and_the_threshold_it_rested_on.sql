-- audit_20260830_active_listings_watchlist_note_attribution_and_the_threshold_it_rested_on
--
-- Metadata only. Replaces the notes text on ONE pipeline_cadence_watchlist row.
-- No threshold change, no severity change, no is_active change, no other row.
--
-- WHY. The note credited this pipeline to "(GitHub Actions)". Measured 2026-08-30
-- over the 76.4h pipeline_runs retention window, that is the arm that does NOTHING:
--   residential Windows Task Scheduler (Trevor's box)  18 runs, 18 ok (100%), 26,584 Atlas calls
--   GitHub Actions (runner IP WAF-blocked by Atlas)     9 runs,  0 ok   (0%),      0 Atlas calls
-- Confirmed by `gh run list` (12/12 scheduled runs `failure`, start times matching
-- the egress_blocked rows to the minute). Attribute by MECHANISM (atlas_calls > 0),
-- never by schedule minute -- the task is registered -StartWhenAvailable, so a
-- sleeping box fires it late at an off-anchor minute and a residential catch-up
-- otherwise lands in the wrong arm.
--
-- AND the threshold's justification is now void. 900 was chosen as "max-governed"
-- off gaps of median 180.0 / p95 399.8 / max 758.2 -- but those were POOLED gaps,
-- kept short partly by the failing GHA arm writing a row every ~3h. That arm is now
-- gated off behind an Atlas reachability probe, so the row stream is residential
-- only. Residential-only gaps over the same window: median 180.0, p95 540.2,
-- MAX 1260.0 -- i.e. ABOVE 900.
--
-- 900 IS KEPT DELIBERATELY, not by inertia: a >900 min gap now means the desktop
-- that is the board's ONLY feeder has been dark, which is precisely the detection
-- the failing arm was masking. It is expected to fire occasionally. If that proves
-- noisy the fix is the box's availability (or a second, datacenter-independent
-- feeder), NOT a bigger number -- raising it would re-hide the thing it now sees.
--
-- REVERT (restores the exact 312-char original):
--   UPDATE public.pipeline_cadence_watchlist SET notes =
--   'TS active-listings ingest (GitHub Actions). Measured 7d: median gap 180.0min, p95 399.8, max 758.2 -- visibly dropout-prone, so threshold is max-governed at 900 rather than 2.5x median (450), which would alert during known-normal operation. medium = visibility only, does not page. Added 2026-07-25 (had no row).'
--   WHERE pipeline = 'topshot-active-listings-ingest';

DO $mig$
DECLARE
  v_old text;
  c_md5 constant text := '9795b7efd5b0ec98732253048b33d3f4';
  c_len constant int  := 312;
  v_n   int;
BEGIN
  SET LOCAL lock_timeout = '5s';

  SELECT notes INTO v_old FROM public.pipeline_cadence_watchlist
   WHERE pipeline = 'topshot-active-listings-ingest';

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: no watchlist row (or NULL notes) for topshot-active-listings-ingest';
  END IF;
  IF length(v_old) <> c_len OR md5(v_old) <> c_md5 THEN
    RAISE EXCEPTION
      'PRE-STATE FAILED: notes changed (len % md5 %, expected % / %) -- re-read before replacing',
      length(v_old), md5(v_old), c_len, c_md5;
  END IF;

  UPDATE public.pipeline_cadence_watchlist
     SET notes =
'TS active-listings ingest. ** ATTRIBUTION CORRECTED 2026-08-30: this is NOT GitHub Actions. ** Two callers, and the load-bearing one is a RESIDENTIAL Windows Task Scheduler task on Trevor''s box. Measured over the 76.4h pipeline_runs retention window: residential 18 runs / 18 ok (100%) / 26,584 Atlas calls; GitHub Actions 9 runs / 0 ok (0%) / 0 Atlas calls, its runner IP WAF-blocked by Atlas -- now gated off behind an Atlas reachability probe in topshot-active-listings-ingest.yml. Attribute by MECHANISM (atlas_calls > 0), never by schedule minute: the task is -StartWhenAvailable, so a sleeping box fires late off-anchor and a residential catch-up lands in the wrong arm. ** The 900 threshold''s original justification is VOID: ** it was max-governed off POOLED gaps (median 180.0 / p95 399.8 / max 758.2) that the failing GHA arm''s 3-hourly rows helped keep short. Residential-only gaps over the same window are median 180.0 / p95 540.2 / MAX 1260.0, i.e. ABOVE 900. 900 is KEPT deliberately: a >900min gap now means the desktop that is the board''s only feeder has been dark, which is exactly the detection the failing arm was masking, so it is EXPECTED to fire sometimes. If it proves noisy the fix is the box''s availability or a second datacenter-independent feeder, NOT a bigger number -- raising it would re-hide what it now sees. medium = visibility only, does not page. Added 2026-07-25.'
   WHERE pipeline = 'topshot-active-listings-ingest';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: updated % rows, expected exactly 1', v_n;
  END IF;
END $mig$;
