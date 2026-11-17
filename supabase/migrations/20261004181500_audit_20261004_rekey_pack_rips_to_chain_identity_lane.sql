-- 2026-10-04 (PT) — a small lane that keeps Top Shot pack_rips.dist_id equal to the CHAIN's answer.
--
-- WHY. 20261004180000 re-keyed the 6,262 rips the chain had verified by 11:00 AM PT. About 59 k more
-- disputed packs are in pack_nft_identity_queue, landing at ~300 per 5 min. New rips also keep
-- getting an INFERRED dist (backfill_pack_rip_metadata's pool vote) before their chain identity
-- lands, and every other writer only fills a NULL. So one pass is not enough; this lane applies each
-- chain answer as it arrives.
--
-- WHAT. rekey_pack_rips_to_chain_identity(): identities CHECKED in the last hour (indexed
-- idx_pack_nft_identity_checked), joined to pack_rips by the unique pack_nft_id index, where the
-- chain's dist (not NULL, not '0', a known pack_distributions row) differs from the rip's. Same
-- backup table and same first-old-value rule as 20261004180000. Measured: ~70 k buffers / ~0.1 s
-- for an hour of identities (vs 890 k for a full scan). Logs `pack-rips-chain-rekey` to
-- pipeline_runs: ok=true only after the UPDATE completed; any error (incl. a timeout) is caught and
-- logged ok=false with its message.
-- pg_cron at :09 / :39 (30 min, 1 h lookback: idempotent overlap).
--
-- anon-exec: revoked (rekey_pack_rips_to_chain_identity) — SECURITY DEFINER writer; pg_cron (postgres) and service_role only.
--
-- REVERT: SELECT cron.unschedule('rpc-pack-rips-chain-rekey'); DROP FUNCTION
--   public.rekey_pack_rips_to_chain_identity(); rips via the backup table (see 20261004180000).

CREATE OR REPLACE FUNCTION public.rekey_pack_rips_to_chain_identity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_n int := 0;
BEGIN
  WITH target AS (
    SELECT r.id, r.pack_nft_id, r.dist_id AS old_dist_id, i.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_rips r ON r.pack_nft_id = i.pack_nft_id AND r.collection_id = i.collection_id
    WHERE i.checked_at > now() - interval '1 hour'
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND r.dist_id IS NOT NULL
      AND i.dist_id <> r.dist_id
      AND EXISTS (SELECT 1 FROM public.pack_distributions d
                   WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id)
  ), saved AS (
    INSERT INTO public.audit_20261004_pack_rips_dist_rekey_backup (rip_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING rip_id
  ), upd AS (
    UPDATE public.pack_rips r
       SET dist_id = t.new_dist_id
      FROM target t
     WHERE r.id = t.id
    RETURNING r.id
  )
  SELECT count(*) INTO v_n FROM upd;

  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, v_n, v_n, 0, true, NULL,
    'nba_top_shot', NULL, NULL, jsonb_build_object('rekeyed', v_n));
  RETURN jsonb_build_object('ok', true, 'rekeyed', v_n);
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- query_canceled named: a 57014 kill escapes WHEN OTHERS (R118). The tail is one
  -- log_pipeline_run insert, bounded even though the timer is not re-armed after a catch.
  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, 0, 0, 0, false, SQLERRM,
    'nba_top_shot', NULL, NULL, '{}'::jsonb);
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.rekey_pack_rips_to_chain_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rekey_pack_rips_to_chain_identity() TO service_role;

SELECT cron.schedule('rpc-pack-rips-chain-rekey', '9,39 * * * *', 'SELECT public.rekey_pack_rips_to_chain_identity();');
