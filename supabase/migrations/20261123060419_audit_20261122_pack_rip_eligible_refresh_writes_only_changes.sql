-- audit_20261122_pack_rip_eligible_refresh_writes_only_changes
-- anon-exec: unchanged (refresh_pack_rip_backfill_eligible) — CREATE OR REPLACE of an existing SECDEF fn, same signature; ACL preserved, has_function_privilege anon = false (read 2026-11-22).
--
-- 2026-11-22 ~10:05 PM PT (Claude Code cloud, evening autonomous pass). WHY. pg_cron job 850 (`14 */2 * * *`)
-- rebuilds the backfill queue pack_rip_backfill_eligible. Every run upserted the WHOLE set (~38.8k rows) to bump
-- refreshed_at and then deleted rows with an older refreshed_at, to record ~30 new rows and 0-4 removals a run.
-- pg_stat_statements: 876k buffers / 89k disk reads per call, 37 s average, 94 s max; the read half measured
-- 468k buffers / 17.8 s on its own, so roughly half the job is rewriting unchanged rows (heap, index and WAL churn).
-- It shares minute :14 of even UTC hours with user reads that timed out at 8:14 PM PT tonight.
--
-- WHAT. ON CONFLICT DO UPDATE only WHERE the stamp differs — the final stamps are exactly what the unconditional
-- upsert left, including restoring a stamp the consumer rotated — and a row leaves the queue by an anti-join
-- against this run's set instead of by a stale refreshed_at (refreshed_at's only reader was that DELETE). Also
-- R120: rows_written now counts rows WRITTEN (was the whole set); rows_found and extra.allday / extra.unpriced keep
-- the set size (check_zero_yield_lanes keys on rows_found, so its reading is unchanged); new
-- extra.allday_written / unpriced_written.
-- Pin: supabase/tests/backfill_pack_rip_metadata.sql (existing assertions unchanged and passing; E1-E3 new — the
-- previous body fails E1).
--
-- REVERT: re-apply the refresh_pack_rip_backfill_eligible block of
--   20261110021600_audit_20261109_rip_metadata_queue_is_read_as_a_rotated_slice.sql (body md5 f791233c88e81c40c351f7094c962c0c).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_pack_rip_backfill_eligible()'::regprocedure)
     IS DISTINCT FROM 'f791233c88e81c40c351f7094c962c0c' THEN
    RAISE EXCEPTION 'refresh_pack_rip_backfill_eligible is not the pinned body; re-read it and re-base';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.refresh_pack_rip_backfill_eligible()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_allday  uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_allday_set int := 0;
  v_allday_n int := 0;
  v_allday_rm int := 0;
  v_unpriced_set int := 0;
  v_unpriced_n int := 0;
  v_unpriced_rm int := 0;
BEGIN
  -- The two eligibility sets backfill_pack_rip_metadata's allday_repair and unpriced_retry legs
  -- used to build on EVERY call (#242). Same predicates as those legs had inline (2026-10-16
  -- set form). WRITE FIRST, then delete only what this refresh did not write: a reader never
  -- sees an empty queue mid-refresh.
  -- 2026-11-09 evening: each row carries its pack_rips stamp so the backfill reads an ordered SLICE.
  -- 2026-11-22: a row is written only when it is NEW or its stamp differs (the final stamps are
  -- exactly what the unconditional upsert left), and a row leaves the queue by an anti-join against
  -- this run's set instead of by a stale refreshed_at. Before, every run rewrote all ~38.8k rows to
  -- record ~30 changes (~400k buffers of the job's ~876k). *_n now counts rows WRITTEN; *_set is
  -- the set size.
  WITH allday_unresolved AS MATERIALIZED (
    SELECT DISTINCT ap.pack_nft_id
    FROM public.allday_pack_pull ap
    WHERE ap.edition_id IS NULL
  ),
  allday_set AS MATERIALIZED (
    SELECT pr.id, pr.metadata_updated_at AS stamp
    FROM public.pack_rips pr
    WHERE pr.collection_id = v_allday
      AND pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM allday_unresolved u WHERE u.pack_nft_id = pr.pack_nft_id)
      AND EXISTS (SELECT 1 FROM public.allday_pack_pull ap WHERE ap.pack_nft_id = pr.pack_nft_id)
  ),
  ins AS (
    INSERT INTO public.pack_rip_backfill_eligible AS q (leg, rip_id, refreshed_at, stamp)
    SELECT 'allday', id, v_started, stamp FROM allday_set
    ON CONFLICT (leg, rip_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at, stamp = EXCLUDED.stamp
      WHERE q.stamp IS DISTINCT FROM EXCLUDED.stamp
    RETURNING 1
  ),
  rm AS (
    DELETE FROM public.pack_rip_backfill_eligible q
     WHERE q.leg = 'allday'
       AND NOT EXISTS (SELECT 1 FROM allday_set s WHERE s.id = q.rip_id)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM allday_set), (SELECT count(*) FROM ins), (SELECT count(*) FROM rm)
    INTO v_allday_set, v_allday_n, v_allday_rm;

  WITH unpriced_set AS MATERIALIZED (
    SELECT pr.id, pr.metadata_updated_at AS stamp
    FROM (SELECT DISTINCT ma.source_pack_rip_id AS rid
            FROM public.moment_acquisitions ma
           WHERE ma.source_pack_rip_id IS NOT NULL) r
    JOIN public.pack_rips pr ON pr.id = r.rid
    WHERE pr.pull_value_usd IS NULL
      AND pr.metadata_updated_at IS NOT NULL
      AND pr.collection_id IS DISTINCT FROM v_allday
  ),
  ins AS (
    INSERT INTO public.pack_rip_backfill_eligible AS q (leg, rip_id, refreshed_at, stamp)
    SELECT 'unpriced', id, v_started, stamp FROM unpriced_set
    ON CONFLICT (leg, rip_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at, stamp = EXCLUDED.stamp
      WHERE q.stamp IS DISTINCT FROM EXCLUDED.stamp
    RETURNING 1
  ),
  rm AS (
    DELETE FROM public.pack_rip_backfill_eligible q
     WHERE q.leg = 'unpriced'
       AND NOT EXISTS (SELECT 1 FROM unpriced_set s WHERE s.id = q.rip_id)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM unpriced_set), (SELECT count(*) FROM ins), (SELECT count(*) FROM rm)
    INTO v_unpriced_set, v_unpriced_n, v_unpriced_rm;

  PERFORM public.log_pipeline_run(
    'pack-rip-backfill-eligible-refresh', v_started,
    v_allday_set + v_unpriced_set, v_allday_n + v_unpriced_n, 0,
    true, NULL, NULL, NULL, NULL,
    jsonb_build_object('allday', v_allday_set, 'unpriced', v_unpriced_set,
                       'allday_written', v_allday_n, 'unpriced_written', v_unpriced_n,
                       'removed', v_allday_rm + v_unpriced_rm));

  RETURN jsonb_build_object('ok', true, 'allday', v_allday_set, 'unpriced', v_unpriced_set,
                            'allday_written', v_allday_n, 'unpriced_written', v_unpriced_n,
                            'removed', v_allday_rm + v_unpriced_rm);
END
$function$;
