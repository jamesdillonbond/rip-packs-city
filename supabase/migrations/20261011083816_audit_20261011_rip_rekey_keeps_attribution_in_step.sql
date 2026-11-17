-- audit_20261011_rip_rekey_keeps_attribution_in_step
-- anon-exec: revoked (rekey_pack_rips_to_chain_identity) — unchanged; SECURITY DEFINER writer, pg_cron + service_role only.
--
-- 2026-10-11 (PT). WHY. rekey_pack_rips_to_chain_identity() (pg_cron :09/:39, since 20261004181500) moves a
-- Top Shot rip's dist_id to Dapper's index answer when they disagree, but never touched
-- topshot_pack_rip_attribution, which carries its OWN dist_id copy. get_pack_realized_ev_row() picks rips
-- for a distribution by that copy ALONE, so every re-keyed rip kept counting under the distribution it was wrongly guessed
-- as. Measured 2026-10-11 ~1:40 AM PT: 34,966 attribution rows disagree with the rip's index identity
-- (rip_dist/high 33,654; empirical_subset/medium 1,311; live_pool_subset 1); in 34,937 of them the rip
-- itself already carries the index dist. 11,248 of those came from last night's re-key run after the
-- one-off identity backfill (697,955 Top Shot rips given index identity; the lane re-keyed 53,559 rips
-- and 40,400 purchases between 7:09 PM and 1:09 AM PT). Calibration that motivated it: a random 500
-- no-identity Top Shot rips had 63 wrong guessed dists (12.6 %), and 22 of 28 'rip_dist'/'high'
-- attributions were wrong.
--
-- WHAT. (1) Backup table audit_20261011_rip_attribution_rekey_backup (first old value per rip kept).
-- (2) One-off: those attribution rows are set to the rip's index dist, method 'dapper_index', confidence
-- 'high', n_editions NULL — exactly what collect_pack_nft_identity / name_packs_from_identity write when
-- the index names a rip. Only where the rip already equals its identity, so attribution follows the rip.
-- (3) The lane now re-syncs the attribution of every rip it re-keys, in the same run, with the same backup.
-- Pins: supabase/tests/rekey_pack_rips_to_chain_identity.sql (K1–K4).
--
-- REVERT: UPDATE public.topshot_pack_rip_attribution a SET dist_id = b.old_dist_id, method = b.old_method,
--   confidence = b.old_confidence, n_editions = b.old_n_editions
--   FROM public.audit_20261011_rip_attribution_rekey_backup b WHERE a.rip_id = b.rip_id;
--   then re-apply the function body from 20261004190000.

CREATE TABLE IF NOT EXISTS public.audit_20261011_rip_attribution_rekey_backup (
  rip_id uuid PRIMARY KEY,
  old_dist_id text,
  old_method text,
  old_confidence text,
  old_n_editions int,
  new_dist_id text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261011_rip_attribution_rekey_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261011_rip_attribution_rekey_backup FROM PUBLIC, anon, authenticated;

WITH target AS (
  SELECT a.rip_id, a.dist_id AS old_dist_id, a.method, a.confidence, a.n_editions, r.dist_id AS new_dist_id
  FROM public.topshot_pack_rip_attribution a
  JOIN public.pack_rips r ON r.id = a.rip_id
  JOIN public.pack_nft_identity i ON i.collection_id = r.collection_id AND i.pack_nft_id = r.pack_nft_id
  WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
    AND r.dist_id = i.dist_id
    AND a.dist_id IS DISTINCT FROM r.dist_id
), saved AS (
  INSERT INTO public.audit_20261011_rip_attribution_rekey_backup (rip_id, old_dist_id, old_method, old_confidence, old_n_editions, new_dist_id)
  SELECT rip_id, old_dist_id, method, confidence, n_editions, new_dist_id FROM target
  ON CONFLICT (rip_id) DO NOTHING
  RETURNING rip_id
)
UPDATE public.topshot_pack_rip_attribution a
   SET dist_id = t.new_dist_id, method = 'dapper_index', confidence = 'high', n_editions = NULL
  FROM target t
 WHERE a.rip_id = t.rip_id;

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
  v_p int := 0;
  v_a int := 0;
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

  -- 2026-10-11: the attribution copy follows the rip (20261011084500). get_pack_realized_ev_row picks
  -- rips by attribution.dist_id alone, so a re-keyed rip left there kept counting under the old dist.
  -- Any attribution row of a rip whose identity (checked in the window) now equals its dist.
  WITH target AS (
    SELECT a.rip_id, a.dist_id AS old_dist_id, a.method, a.confidence, a.n_editions, r.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_rips r ON r.pack_nft_id = i.pack_nft_id AND r.collection_id = i.collection_id
    JOIN public.topshot_pack_rip_attribution a ON a.rip_id = r.id
    WHERE i.checked_at > now() - interval '1 hour'
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND r.dist_id = i.dist_id
      AND a.dist_id IS DISTINCT FROM r.dist_id
  ), saved AS (
    INSERT INTO public.audit_20261011_rip_attribution_rekey_backup (rip_id, old_dist_id, old_method, old_confidence, old_n_editions, new_dist_id)
    SELECT rip_id, old_dist_id, method, confidence, n_editions, new_dist_id FROM target
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING rip_id
  ), upd AS (
    UPDATE public.topshot_pack_rip_attribution a
       SET dist_id = t.new_dist_id, method = 'dapper_index', confidence = 'high', n_editions = NULL
      FROM target t
     WHERE a.rip_id = t.rip_id
    RETURNING a.rip_id
  )
  SELECT count(*) INTO v_a FROM upd;

  -- 2026-10-04: purchases too (20261004190000). Same chain-only rule, own backup table.
  WITH target AS (
    SELECT p.id, p.pack_nft_id, p.pack_dist_id AS old_dist_id, i.dist_id AS new_dist_id
    FROM public.pack_nft_identity i
    JOIN public.pack_purchases p ON p.pack_nft_id = i.pack_nft_id AND p.collection_id = i.collection_id
    WHERE i.checked_at > now() - interval '1 hour'
      AND i.collection_id = v_ts
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND p.pack_dist_id IS NOT NULL
      AND i.dist_id <> p.pack_dist_id
      AND EXISTS (SELECT 1 FROM public.pack_distributions d
                   WHERE d.collection_id = i.collection_id AND d.dist_id = i.dist_id)
  ), saved AS (
    INSERT INTO public.audit_20261004_pack_purchases_dist_rekey_backup (purchase_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
    ON CONFLICT (purchase_id) DO NOTHING
    RETURNING purchase_id
  ), upd AS (
    UPDATE public.pack_purchases p
       SET pack_dist_id = t.new_dist_id
      FROM target t
     WHERE p.id = t.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_p FROM upd;

  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, v_n + v_p, v_n + v_p + v_a, 0, true, NULL,
    'nba_top_shot', NULL, NULL, jsonb_build_object('rekeyed', v_n, 'purchases_rekeyed', v_p, 'attribution_synced', v_a));
  RETURN jsonb_build_object('ok', true, 'rekeyed', v_n, 'purchases_rekeyed', v_p, 'attribution_synced', v_a);
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
