-- audit_20261102_mint_probes_for_unindexed_packs — 2026-11-02 (Claude Code cloud; Trevor: "Keep going").
--
-- WHY. A Top Shot pack's drop is on chain only in its PackNFT `Minted` event, and
-- fill_pack_dist_from_chain_mints (20261102232403) can name a pack only once pack_nft_mints holds
-- that event. run_pack_mint_probe_lane queues probe instants ONLY from pack_nft_identity.acquired_at
-- — i.e. from Dapper's index — so a drop minted after the index froze (#218) is never probed: that is
-- how the AJ Dybantsa Tip-Off (8911) stayed invisible, and how a Rookie Debut drop (11-11) would if
-- the index is still frozen then.
--
-- 8911's mint instant was found by hand: its pack ids are Flow resource uuids — a high-bits PARTITION
-- (id >> 40) plus a per-partition counter that only increases — so bracketing an id between the
-- nearest known-time ids in the same partition (Disney Pinnacle mints, live, and known Top Shot mints)
-- bounds its mint time. Five 8911 ids gave 10-29 6:10–7:20 PM PT; probes there recorded all 1,500.
--
-- WHAT. enqueue_mint_probes_for_unindexed_packs(p_max_probes, p_ids): targets = Top Shot packs seen
-- in the last 30 days (rips / purchases) with no dist and no pack_nft_mints row (or p_ids, for a
-- targeted run). Each is bracketed; windows ≤ 6 h get probe instants every 3 min (a probe reads 250
-- blocks ≈ 3.3 min), inserted ON CONFLICT DO NOTHING at priority 4 — an instant already probed is not
-- re-queued, so a window that was searched and found nothing cannot loop. Hourly pg_cron at :52.
-- ⚠ The text-keyed PKs are range-scanned with a same-length filter: within one digit length,
-- lexicographic order is numeric order.
--
-- anon-exec: revoked (enqueue_mint_probes_for_unindexed_packs) — maintenance, writes; pg_cron/postgres only.
--
-- REVERT: SELECT cron.unschedule('rpc-mint-probes-for-unindexed-packs');
--         DROP FUNCTION public.enqueue_mint_probes_for_unindexed_packs(integer, text[]);

CREATE FUNCTION public.enqueue_mint_probes_for_unindexed_packs(p_max_probes integer DEFAULT 40, p_ids text[] DEFAULT NULL)
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

  SELECT count(*) FILTER (WHERE lo IS NOT NULL AND hi IS NOT NULL AND hi > lo AND hi - lo <= interval '6 hours'),
         count(*) FILTER (WHERE lo IS NOT NULL AND hi IS NOT NULL AND hi - lo > interval '6 hours'),
         (SELECT jsonb_agg(jsonb_build_object('lo', lo, 'hi', hi)) FROM (SELECT DISTINCT lo, hi FROM _br WHERE lo IS NOT NULL AND hi IS NOT NULL ORDER BY lo LIMIT 10) w)
    INTO v_bracketed, v_wide, v_windows
  FROM _br;

  IF v_max > 0 THEN
    WITH inst AS (
      SELECT DISTINCT date_trunc('minute', g) AS probe_at
      FROM _br, generate_series(lo, hi, interval '3 minutes') g
      WHERE lo IS NOT NULL AND hi IS NOT NULL AND hi > lo AND hi - lo <= interval '6 hours'
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
REVOKE EXECUTE ON FUNCTION public.enqueue_mint_probes_for_unindexed_packs(integer, text[]) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('rpc-mint-probes-for-unindexed-packs', '52 * * * *', $cron$SELECT public.enqueue_mint_probes_for_unindexed_packs(40)$cron$);
