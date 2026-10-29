-- STAGED, NOT APPLIED (2026-10-29 ~12:05 PM PT, Claude Code cloud). apply_migration raised a Supabase MCP approval
-- prompt that never reached the client. To apply: approve it from a client that shows the prompt, or paste into the
-- SQL editor; then commit as supabase/migrations/<version>_audit_20261029_reprice_drifted_high_value_rips.sql.
--
-- audit_20261029_reprice_drifted_high_value_rips — 2026-10-29 (Claude Code cloud). #217 option (c), narrowed.
--
-- pack_rips.pull_value_usd is contractually CURRENT FMV (20260913032000), but the only leg that keeps a
-- valued row current (backfill_pack_rip_metadata.stale_valued) re-prices ~300 rows/h against 394k valued
-- rows: a ~55-day cycle. Today's repairs (20261029174207, 20261029175806) re-priced 116 rips stored at
-- $132k against a current $8.9k, almost all priced off a lone first ask that later collapsed. The harm
-- is concentrated in a small, high-value population, so this lane covers exactly that, daily:
--
--   Top Shot and All Day rips stored >= $100 (6,653 rows on 10-29) whose CURRENT whole-pack value,
--   computed by each collection's own writer rule (all-or-nothing, pull count = moments_pulled), has
--   drifted more than 3x either way. They get the current value and a fresh metadata_updated_at,
--   which is exactly what the stale leg would write when it reached them.
--
-- COST (measured 10-29, Top Shot leg, cold): 225k buffers / 31 s for 4,886 candidates; All Day's leg
-- is smaller. Once a day that is ~10 % on top of the hourly backfill job (49k-161k buffers per call x 24).
-- Schedule: 26 11 * * * (4:26 AM PT; minute 26 has one other job; not 0/1/20/21/40/41; hour 11 is
-- outside the hours-divisible-by-3 band), ahead of the 12:05 UTC rip-values MV refresh.
--
-- anon-exec: revoked (reprice_drifted_high_value_rips) — a maintenance writer; only its pg_cron owner and service_role run it.
-- REVERT: SELECT cron.unschedule('rpc-reprice-drifted-high-value-rips');
--         DROP FUNCTION public.reprice_drifted_high_value_rips(numeric, numeric);

CREATE OR REPLACE FUNCTION public.reprice_drifted_high_value_rips(p_min_stored numeric DEFAULT 100, p_ratio numeric DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts  constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_ad  constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_ts_cand int := 0; v_ts_upd int := 0;
  v_ad_cand int := 0; v_ad_upd int := 0;
  v_down int := 0; v_up int := 0;
BEGIN
  IF p_min_stored IS NULL OR p_min_stored <= 0 OR p_ratio IS NULL OR p_ratio <= 1 THEN
    RAISE EXCEPTION 'reprice_drifted_high_value_rips: p_min_stored > 0 and p_ratio > 1 required';
  END IF;

  -- Top Shot: the writer rule of backfill_pack_rip_metadata / price_recent_topshot_rips.
  DROP TABLE IF EXISTS _rdr;
  CREATE TEMP TABLE _rdr ON COMMIT DROP AS
  WITH big AS (
    SELECT pr.id, pr.collection_id, pr.moments_pulled, pr.pull_value_usd
      FROM public.pack_rips pr
     WHERE pr.collection_id = v_ts
       AND pr.pull_value_usd >= p_min_stored
  )
  SELECT b.id, b.pull_value_usd AS stored, SUM(fc.fmv_usd)::numeric(14,2) AS curv
    FROM big b
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = b.id
    LEFT JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = b.collection_id
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.collection_id
        FROM public.fmv_snapshots s
       WHERE s.edition_id = m.edition_id
       ORDER BY s.computed_at DESC
       LIMIT 1
    ) fc ON fc.collection_id = m.collection_id
   GROUP BY b.id, b.pull_value_usd, b.moments_pulled
  HAVING count(*) = count(fc.fmv_usd)
     AND count(*) = b.moments_pulled;
  GET DIAGNOSTICS v_ts_cand = ROW_COUNT;

  -- All Day: the writer rule of rollup_allday_rip_pull_value (exact join on pack_nft_id).
  INSERT INTO _rdr (id, stored, curv)
  SELECT b.id, b.pull_value_usd, SUM(fc.fmv_usd)::numeric(14,2)
    FROM public.pack_rips b
    JOIN public.allday_pack_pull ap ON ap.pack_nft_id = b.pack_nft_id
    LEFT JOIN LATERAL (
      SELECT f.fmv_usd
        FROM public.fmv_snapshots f
       WHERE f.edition_id = ap.edition_id
       ORDER BY f.computed_at DESC
       LIMIT 1
    ) fc ON true
   WHERE b.collection_id = v_ad
     AND b.pull_value_usd >= p_min_stored
   GROUP BY b.id, b.pull_value_usd, b.moments_pulled
  HAVING count(*) = count(fc.fmv_usd)
     AND count(*) = b.moments_pulled;
  GET DIAGNOSTICS v_ad_cand = ROW_COUNT;

  WITH upd AS (
    UPDATE public.pack_rips pr
       SET pull_value_usd = r.curv,
           metadata_updated_at = now()
      FROM _rdr r
     WHERE pr.id = r.id
       AND r.curv > 0
       AND (r.curv < r.stored / p_ratio OR r.curv > r.stored * p_ratio)
    RETURNING pr.collection_id, (r.curv < r.stored) AS went_down
  )
  SELECT count(*) FILTER (WHERE collection_id = v_ts),
         count(*) FILTER (WHERE collection_id = v_ad),
         count(*) FILTER (WHERE went_down),
         count(*) FILTER (WHERE NOT went_down)
    INTO v_ts_upd, v_ad_upd, v_down, v_up
    FROM upd;

  PERFORM public.log_pipeline_run('reprice-drifted-rips', v_started, v_ts_cand + v_ad_cand, v_ts_upd + v_ad_upd, 0, true, NULL,
    NULL, NULL, NULL, jsonb_build_object('source', 'audit_20261029', 'min_stored', p_min_stored, 'ratio', p_ratio,
      'topshot_candidates', v_ts_cand, 'topshot_repriced', v_ts_upd,
      'allday_candidates', v_ad_cand, 'allday_repriced', v_ad_upd,
      'went_down', v_down, 'went_up', v_up));
  RETURN jsonb_build_object('topshot_candidates', v_ts_cand, 'topshot_repriced', v_ts_upd,
    'allday_candidates', v_ad_cand, 'allday_repriced', v_ad_upd, 'went_down', v_down, 'went_up', v_up);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('reprice-drifted-rips', v_started, 0, 0, 0, false, SQLERRM,
    NULL, NULL, NULL, jsonb_build_object('source', 'audit_20261029', 'sqlstate', SQLSTATE));
  RETURN jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reprice_drifted_high_value_rips(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reprice_drifted_high_value_rips(numeric, numeric) TO service_role;

SELECT cron.schedule('rpc-reprice-drifted-high-value-rips', '26 11 * * *',
  'SELECT public.reprice_drifted_high_value_rips();');

DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.reprice_drifted_high_value_rips(numeric, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute reprice_drifted_high_value_rips';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-reprice-drifted-high-value-rips' AND active) THEN
    RAISE EXCEPTION 'job not scheduled';
  END IF;
END
$post$;
