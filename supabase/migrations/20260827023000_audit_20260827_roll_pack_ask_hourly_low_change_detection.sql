-- public.roll_pack_ask_hourly_low(): add change detection to BOTH unguarded writes.
--
-- WHY. This function ran every 15 minutes (pg_cron jobid 77) and rewrote its two
-- tables in full on every tick. Measured 2026-08-26 over the real population:
--
--     statement                        rows written/call   genuinely changed
--     INSERT .. ON CONFLICT DO UPDATE       2,981                 1
--     UPDATE pack_ask_state                 2,988                 1
--
-- Per hour that is 4 x (2,981 + 2,988) + one 2,970-row prune = 26,846 row writes
-- to effect ~8. pg_stat_statements attributed 726.3 MB of WAL/day and 304,851
-- blocks dirtied/day to this function - ~2.5% of all WAL on an instance whose
-- sole constraint is disk IO.
--
-- The data justifies it: over 71,407 real hour-buckets in 24h, 96.88% of pack
-- distributions had exactly ONE distinct low_ask all day (avg 1.058). Asks are
-- essentially static; the rewrites were re-storing values already present.
--
-- EQUIVALENCE, proven over the population rather than argued (2026-08-26):
-- both bodies were run against independent copies of the real tables (3,025
-- pack_ask_state rows, 499,186 pack_ask_hourly_low rows) and the symmetric
-- difference of the results was 0 rows in BOTH tables, while rows written fell
-- 2,981 -> 1 and 2,988 -> 1.
--   * Leg 1 is safe because LEAST() cannot change a row the predicate excludes:
--     if existing <= EXCLUDED then LEAST(existing, EXCLUDED) = existing.
--   * Leg 2 is safe because the UPDATE sets exactly the two columns the
--     predicate tests, so a skipped row was already at its target value.
--
-- ⚠ The pinned test is STRUCTURALLY BLIND to leg 1 and cannot be made to see it
-- by asserting values. LEAST() already guarantees the stored value with or
-- without the predicate, so every value assertion passes either way - verified
-- by running an INVERTED predicate through the same assertions, which also
-- passed. The predicate changes only whether a physical write occurs. What IS
-- sensitive is ROW_COUNT, so that is what the re-pointed pin now asserts.
--
-- ⚠ ROW_COUNT semantics change, deliberately. `rolled` was "rows touched" and
-- was therefore a CONSTANT: all 185 runs in the 48h before this change reported
-- rows_found = rows_written = 2,971-2,981, i.e. the metric never carried
-- information. It now means "rows actually changed". To keep the previous
-- signal readable, p_rows_found now carries the CANDIDATE count (the old
-- number) and p_rows_written the true change count, with both plus the
-- pack_ask_state change count added to p_extra.
--   Safe to change: the ONLY caller is pg_cron jobid 77
--   (`SELECT public.roll_pack_ask_hourly_low()`), which discards the return
--   value. No view, trigger, PostgREST route or repo TypeScript references it,
--   and no function reads this pipeline's rows_written (checked against
--   pg_proc, pg_views, cron.job, pg_trigger and a full-repo grep).
--
-- The returned jsonb shape is intentionally UNCHANGED.
--
-- anon-exec: unchanged — roll_pack_ask_hourly_low was already revoked, verified
-- live AFTER this apply: has_function_privilege() reads anon=false,
-- authenticated=false (it is SECURITY DEFINER and pg_cron-only). No REVOKE is
-- added here on purpose: CREATE OR REPLACE FUNCTION does not reset a function's
-- ACL, so a revoke in this file would imply a privilege change that did not
-- happen. Re-verify with has_function_privilege, never the proacl text.
--
-- Pinned by supabase/tests/roll_pack_ask_hourly_low.sql.
-- Revert: re-apply 20260802204000_audit_20260802_snapshot_roll_pack_ask_hourly_low.sql.

CREATE OR REPLACE FUNCTION public.roll_pack_ask_hourly_low()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_bucket     timestamptz := date_trunc('hour', now());
  v_candidates int := 0;
  v_rolled     int := 0;
  v_state      int := 0;
  v_pruned     int := 0;
BEGIN
  SELECT count(*) INTO v_candidates
  FROM public.pack_ask_state s
  WHERE s.is_listed = true AND s.lowest_ask > 0;

  INSERT INTO public.pack_ask_hourly_low (collection_slug, dist_id, hour_bucket, low_ask)
  SELECT s.collection_slug, s.dist_id, v_bucket, s.lowest_ask
  FROM public.pack_ask_state s
  WHERE s.is_listed = true AND s.lowest_ask > 0
  ON CONFLICT (collection_slug, dist_id, hour_bucket)
  DO UPDATE SET low_ask = LEAST(public.pack_ask_hourly_low.low_ask, EXCLUDED.low_ask)
  WHERE public.pack_ask_hourly_low.low_ask > EXCLUDED.low_ask;
  GET DIAGNOSTICS v_rolled = ROW_COUNT;

  DELETE FROM public.pack_ask_hourly_low WHERE hour_bucket < now() - interval '7 days';
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  UPDATE public.pack_ask_state s
  SET low_ask_24h = agg.lo_24h,
      low_ask_7d  = agg.lo_7d
  FROM (
    SELECT collection_slug, dist_id,
           min(low_ask) FILTER (WHERE hour_bucket >= now() - interval '24 hours') AS lo_24h,
           min(low_ask) AS lo_7d
    FROM public.pack_ask_hourly_low
    GROUP BY collection_slug, dist_id
  ) agg
  WHERE agg.collection_slug = s.collection_slug AND agg.dist_id = s.dist_id
    AND (s.low_ask_24h IS DISTINCT FROM agg.lo_24h
      OR s.low_ask_7d  IS DISTINCT FROM agg.lo_7d);
  GET DIAGNOSTICS v_state = ROW_COUNT;

  BEGIN
    PERFORM public.log_pipeline_run(
      p_pipeline   => 'pack-ask-hourly-low-roll',
      p_started_at => v_started,
      p_rows_found => v_candidates,
      p_rows_written => v_rolled,
      p_rows_skipped => v_pruned,
      p_ok         => true,
      p_extra      => jsonb_build_object('bucket', v_bucket, 'pruned', v_pruned,
                                         'candidates', v_candidates,
                                         'state_rows_changed', v_state)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- monitoring log is best-effort; never fail the roll
  END;

  RETURN jsonb_build_object('bucket', v_bucket, 'rolled', v_rolled, 'pruned', v_pruned, 'at', now());
END;
$function$;
