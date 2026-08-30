-- Note-only correction. No threshold change, no severity change, no behaviour change.
-- The live note said "hourly cron-job.org ... 3 missed runs trigger alert" and framed the
-- 2026-06-06 dropout as a flaky external trigger. Measured 2026-08-30 03:1xZ that framing
-- sent this pass toward the wrong diagnosis, so it is corrected in place.
-- Revert: restore the previous note text, which is quoted verbatim in the guard below.

DO $do$
DECLARE
  v_old text;
BEGIN
  SELECT notes INTO v_old FROM public.pipeline_cadence_watchlist
   WHERE pipeline = 'pinnacle-resolve-buyers';

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'no pipeline_cadence_watchlist row for pinnacle-resolve-buyers; aborting.';
  END IF;
  IF v_old NOT LIKE '%hourly cron-job.org%' THEN
    RAISE EXCEPTION 'watchlist note for pinnacle-resolve-buyers is not the text this migration expects; aborting. Current: %', left(v_old, 200);
  END IF;

  UPDATE public.pipeline_cadence_watchlist
     SET notes = v_old || ' | ⚠ 2026-08-30 CORRECTION (migration 20260830030857 + this one): '
       || 'THIS ARM IS NOT AN "hourly cron-job.org" CADENCE AND THE 2026-06-06 "flaky external trigger" '
       || 'READING IS WRONG FOR THE 08-29 BREACH. The route (app/api/pinnacle/resolve-buyers) returns '
       || '{status:"no_work"} BEFORE log_pipeline_run, so an EMPTY CLAIM WRITES NO pipeline_runs ROW AT ALL '
       || '-- a queue starved by its own predicate is indistinguishable from a dead cron. That is exactly '
       || 'what the 1,536-min breach was: claim_pinnacle_resolver_batch() claimed only '
       || 'buyer_address = ''0xedf9df96c92f4595'' (Pinnacle trade contract), while pinnacle-sales-indexer '
       || 'has written NULL instead since 2026-08-13T01:11:42Z -- trade-contract count 0 on every one of the '
       || 'last 35 days, 6,671 of 7,872 sales since 08-13 unclaimable, 15,714 estate-wide, and '
       || 'pinnacle_resolver_status reported total_still_unresolved = 0 because it used the same predicate. '
       || 'Both were widened to (trade contract OR NULL) by 20260830030857; verified from outside, the '
       || '03:13:35Z run claimed 50 / resolved 50 / 0 errors vs total_claimed:1 on each prior run. '
       || '👉 DO NOT RAISE max_silent_minutes ON THIS ARM ON THE STRENGTH OF THE 08-29 BREACH -- the arm was '
       || 'RIGHT that something was wrong. Re-derive the threshold only after the backlog drains, from the '
       || 'measured post-drain cadence (observed 1 run/h at 50 rows/run, NOT the 288/day the route header '
       || 'implies; historical peak was 33 runs/day). ⛔ Root cause is still OPEN and upstream: '
       || 'pinnacle-sales-indexer filled buyers inline through 08-12 and stopped -- needs its diff around '
       || '2026-08-13T01:11Z. Discriminator that survives the fix: '
       || 'SELECT count(*) FROM pinnacle_sales WHERE resolution_status = ''resolved'' AND sold_at > ''2026-08-13'';'
   WHERE pipeline = 'pinnacle-resolve-buyers';
END
$do$;
