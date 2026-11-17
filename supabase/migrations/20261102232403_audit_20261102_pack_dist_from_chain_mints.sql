-- audit_20261102_pack_dist_from_chain_mints — 2026-11-02 (Claude Code cloud; Trevor: "Keep going").
--
-- WHY. A Top Shot pack's drop is recorded on chain in exactly one place: the PackNFT `Minted(id, hash,
-- distId)` event (deployed source read 11-02 via Flow REST: the NFT resource has no distId field, and
-- its own comment notes the id -> distribution mapping is not on chain). pack_nft_mints holds those
-- events (run_pack_mint_probe_lane), but NOTHING copied them onto pack_rips / pack_purchases — those
-- took their dist from Dapper's index (pack_nft_identity) or the pool vote. With Dapper's index frozen
-- (#218) the AJ Dybantsa Tip-Off (8911) was invisible: 237 of its opens sat NULL after 20261102201245.
--
-- 8911's mint instant was found by bracketing its pack ids (Flow resource uuids, partitioned
-- counters) between Disney Pinnacle mint ids of known time in the same partitions: 10-29 6:10–7:20
-- PM PT; probes there recorded all 1,500 mints, 6:26:33–6:26:42 PM PT, distId 8911. Check: the 631
-- rips 20261102201245 re-keyed to 8911 — 631 chain-confirmed, 0 contradicted. Estate-wide 0 packs
-- where the chain disagrees with a resolved pack_nft_identity row.
--
-- WHAT. fill_pack_dist_from_chain_mints(p_limit): FILL-ONLY — sets pack_rips.dist_id /
-- pack_purchases.pack_dist_id from pack_nft_mints where the stored dist is NULL (both partial-indexed).
-- An override path (chain beats an unconfirmed vote) was measured first and found 0 rows estate-wide,
-- and 20261102201245 stops new ambiguous votes, so it is not built. Every fill is logged with its old
-- value (pack_dist_chain_fill_log). Hourly pg_cron + one run now (237 rips, 1,115 purchases measured).
--
-- anon-exec: revoked (fill_pack_dist_from_chain_mints) — maintenance, writes; pg_cron/postgres only.
--
-- REVERT:
--   UPDATE public.pack_rips r SET dist_id = l.old_dist_id FROM public.pack_dist_chain_fill_log l
--    WHERE l.kind = 'rip' AND r.id = l.row_id;
--   UPDATE public.pack_purchases p SET pack_dist_id = l.old_dist_id FROM public.pack_dist_chain_fill_log l
--    WHERE l.kind = 'purchase' AND p.id = l.row_id;
--   SELECT cron.unschedule('rpc-pack-dist-from-chain-mints');
--   DROP FUNCTION public.fill_pack_dist_from_chain_mints(integer); DROP TABLE public.pack_dist_chain_fill_log;

CREATE TABLE public.pack_dist_chain_fill_log (
  kind        text        NOT NULL,     -- 'rip' | 'purchase'
  row_id      uuid        NOT NULL,
  pack_nft_id text        NOT NULL,
  old_dist_id text,
  new_dist_id text        NOT NULL,
  filled_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, row_id, filled_at)
);
ALTER TABLE public.pack_dist_chain_fill_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_dist_chain_fill_log FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fill_pack_dist_from_chain_mints(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_lim int := greatest(1, least(coalesce(p_limit, 5000), 20000));
  v_rips int := 0;
  v_purch int := 0;
BEGIN
  WITH t AS (
    SELECT r.id, r.pack_nft_id, r.dist_id AS old_dist_id, m.dist_id AS new_dist_id
    FROM public.pack_rips r
    JOIN public.pack_nft_mints m ON m.collection_id = r.collection_id AND m.pack_nft_id = r.pack_nft_id
    WHERE r.collection_id = v_ts
      AND r.dist_id IS NULL                       -- idx_pack_rips_unattributed
      AND m.dist_id IS NOT NULL AND m.dist_id ~ '^[0-9]+$'
    LIMIT v_lim
  ), logged AS (
    INSERT INTO public.pack_dist_chain_fill_log (kind, row_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT 'rip', id, pack_nft_id, old_dist_id, new_dist_id FROM t
    RETURNING row_id, new_dist_id
  ), upd AS (
    UPDATE public.pack_rips r SET dist_id = l.new_dist_id
    FROM logged l WHERE r.id = l.row_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rips FROM upd;

  WITH t AS (
    SELECT p.id, p.pack_nft_id, p.pack_dist_id AS old_dist_id, m.dist_id AS new_dist_id
    FROM public.pack_purchases p
    JOIN public.pack_nft_mints m ON m.collection_id = p.collection_id AND m.pack_nft_id = p.pack_nft_id
    WHERE p.collection_id = v_ts
      AND p.pack_dist_id IS NULL                  -- idx_pack_purchases_dist_unresolved
      AND m.dist_id IS NOT NULL AND m.dist_id ~ '^[0-9]+$'
    LIMIT v_lim
  ), logged AS (
    INSERT INTO public.pack_dist_chain_fill_log (kind, row_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT 'purchase', id, pack_nft_id, old_dist_id, new_dist_id FROM t
    RETURNING row_id, new_dist_id
  ), upd AS (
    UPDATE public.pack_purchases p SET pack_dist_id = l.new_dist_id
    FROM logged l WHERE p.id = l.row_id
    RETURNING 1
  )
  SELECT count(*) INTO v_purch FROM upd;

  -- rows_written = rows actually updated (each logged with its old value first).
  PERFORM public.log_pipeline_run('pack-dist-from-chain-mints', v_started, v_rips + v_purch, v_rips + v_purch, 0, true, NULL,
                                  'nba_top_shot', NULL, NULL,
                                  jsonb_build_object('rips_filled', v_rips, 'purchases_filled', v_purch));
  RETURN jsonb_build_object('ok', true, 'rips_filled', v_rips, 'purchases_filled', v_purch);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.fill_pack_dist_from_chain_mints(integer) FROM PUBLIC, anon, authenticated;

SELECT public.fill_pack_dist_from_chain_mints(5000);
SELECT cron.schedule('rpc-pack-dist-from-chain-mints', '47 * * * *', $cron$SELECT public.fill_pack_dist_from_chain_mints(5000)$cron$);
