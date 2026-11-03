-- audit_20261102_mint_probes_temp_tables_reentrant — 2026-11-02 (Claude Code cloud).
--
-- enqueue_mint_probes_for_unindexed_packs (applied minutes earlier) raised 42P07 "relation _tgt already
-- exists" when called twice in one transaction: its ON COMMIT DROP temp tables outlive the first call
-- until COMMIT. pg_cron runs one call per transaction, so production was unaffected; the positive
-- control (two calls in one SELECT) hit it. Body = the previous migration's verbatim, plus two
-- DROP TABLE IF EXISTS at the top.
--
-- ALSO: an EXACT bracket was discarded. When a pack's nearest lower AND upper neighbours were minted in
-- the same block, lo = hi and the filter `hi > lo` dropped it — the positive control's five 8911 packs
-- all bracketed to one instant (10-29 6:26 PM PT) and enqueued 0. Now `hi >= lo`; generate_series
-- yields the single instant.
--
-- anon-exec: unchanged (enqueue_mint_probes_for_unindexed_packs) — CREATE OR REPLACE of an existing fn; ACL preserved (revoked from PUBLIC/anon/authenticated in the previous migration).
--
-- REVERT: re-apply the function from the previous migration (audit_20261102_mint_probes_for_unindexed_packs).

CREATE OR REPLACE FUNCTION public.enqueue_mint_probes_for_unindexed_packs(p_max_probes integer DEFAULT 40, p_ids text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_part constant numeric := 1099511627776;   -- 2^40
  v_max int := greatest(0, least(coalesce(p_max_probes, 40), 200));
  v_targets int := 0;
  v_bracketed int := 0;
  v_wide int := 0;
  v_enqueued int := 0;
  v_windows jsonb;
BEGIN
  -- Two calls in ONE transaction collided on these ON COMMIT DROP tables (42P07) — found by the
  -- positive control, which called it twice in one statement.
  DROP TABLE IF EXISTS _tgt;
  DROP TABLE IF EXISTS _br;
  CREATE TEMP TABLE _tgt ON COMMIT DROP AS
  SELECT DISTINCT x.pack_nft_id
  FROM (
    SELECT unnest(p_ids) AS pack_nft_id WHERE p_ids IS NOT NULL
    UNION
    SELECT pp.pack_nft_id FROM public.pack_purchases pp
     WHERE p_ids IS NULL AND pp.collection_id = v_ts AND pp.pack_dist_id IS NULL AND pp.sealed_at > now() - interval '30 days'
    UNION
    SELECT r.pack_nft_id FROM public.pack_rips r
     WHERE p_ids IS NULL AND r.collection_id = v_ts AND r.dist_id IS NULL AND r.sealed_at > now() - interval '30 days'
  ) x
  WHERE x.pack_nft_id ~ '^[0-9]{6,20}$'
    AND (p_ids IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.pack_nft_mints m WHERE m.collection_id = v_ts AND m.pack_nft_id = x.pack_nft_id))
  LIMIT 200;
  SELECT count(*) INTO v_targets FROM _tgt;

  CREATE TEMP TABLE _br ON COMMIT DROP AS
  WITH b AS (
    SELECT t.pack_nft_id,
           (floor(t.pack_nft_id::numeric / v_part) * v_part)::text AS p_lo,
           ((floor(t.pack_nft_id::numeric / v_part) + 1) * v_part - 1)::text AS p_hi
    FROM _tgt t
  )
  SELECT b.pack_nft_id,
    greatest(
      (SELECT e.minted_at FROM public.pinnacle_mint_events e
        WHERE e.nft_id < b.pack_nft_id AND e.nft_id >= b.p_lo AND length(e.nft_id) = length(b.pack_nft_id)
        ORDER BY e.nft_id DESC LIMIT 1),
      (SELECT m.minted_at FROM public.pack_nft_mints m
        WHERE m.collection_id = v_ts AND m.pack_nft_id < b.pack_nft_id AND m.pack_nft_id >= b.p_lo
          AND length(m.pack_nft_id) = length(b.pack_nft_id) AND m.pack_nft_id <> b.pack_nft_id
        ORDER BY m.pack_nft_id DESC LIMIT 1)
    ) AS lo,
    least(
      (SELECT e.minted_at FROM public.pinnacle_mint_events e
        WHERE e.nft_id > b.pack_nft_id AND e.nft_id <= b.p_hi AND length(e.nft_id) = length(b.pack_nft_id)
        ORDER BY e.nft_id ASC LIMIT 1),
      (SELECT m.minted_at FROM public.pack_nft_mints m
        WHERE m.collection_id = v_ts AND m.pack_nft_id > b.pack_nft_id AND m.pack_nft_id <= b.p_hi
          AND length(m.pack_nft_id) = length(b.pack_nft_id) AND m.pack_nft_id <> b.pack_nft_id
        ORDER BY m.pack_nft_id ASC LIMIT 1)
    ) AS hi
  FROM b;

  SELECT count(*) FILTER (WHERE lo IS NOT NULL AND hi IS NOT NULL AND hi >= lo AND hi - lo <= interval '6 hours'),
         count(*) FILTER (WHERE lo IS NOT NULL AND hi IS NOT NULL AND hi - lo > interval '6 hours'),
         (SELECT jsonb_agg(jsonb_build_object('lo', lo, 'hi', hi)) FROM (SELECT DISTINCT lo, hi FROM _br WHERE lo IS NOT NULL AND hi IS NOT NULL ORDER BY lo LIMIT 10) w)
    INTO v_bracketed, v_wide, v_windows
  FROM _br;

  IF v_max > 0 THEN
    WITH inst AS (
      SELECT DISTINCT date_trunc('minute', g) AS probe_at
      FROM _br, generate_series(lo, hi, interval '3 minutes') g
      WHERE lo IS NOT NULL AND hi IS NOT NULL AND hi >= lo AND hi - lo <= interval '6 hours'
      ORDER BY 1
      LIMIT v_max
    ), ins AS (
      INSERT INTO public.pack_mint_probes (collection_id, probe_at, priority)
      SELECT v_ts, probe_at, 4 FROM inst
      ON CONFLICT (collection_id, probe_at) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_enqueued FROM ins;
  END IF;

  PERFORM public.log_pipeline_run('mint-probes-for-unindexed-packs', v_started, v_targets, v_enqueued, v_wide, true, NULL,
                                  'nba_top_shot', NULL, NULL,
                                  jsonb_build_object('targets', v_targets, 'bracketed', v_bracketed, 'too_wide', v_wide,
                                                     'probes_enqueued', v_enqueued, 'targeted', p_ids IS NOT NULL));
  RETURN jsonb_build_object('ok', true, 'targets', v_targets, 'bracketed', v_bracketed, 'too_wide', v_wide,
                            'probes_enqueued', v_enqueued, 'windows', v_windows);
END
$function$;
