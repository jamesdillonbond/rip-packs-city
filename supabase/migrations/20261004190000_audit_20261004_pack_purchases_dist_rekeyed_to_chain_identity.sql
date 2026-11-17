-- 2026-10-04 (PT) — Top Shot pack_purchases.pack_dist_id re-keyed to the CHAIN's answer too, and the
-- re-key lane extended to purchases.
--
-- DECISION (Trevor delegated it, ~11:20 AM PT: "do what you think is best"). The open question was
-- whether a purchase should keep the dist it was BOUGHT AS, if a pack converts. Measured, it never
-- converts. Of 4,208 Top Shot purchases whose dist disagrees with pack_nft_identity, most are
-- `primary_withdraw` rows (packs delivered at a drop). Their dist came from matching the delivery to a
-- drop window, and Standard / Trade Ticket / Chance Hit / reward packs released together are
-- DIFFERENT NFTs in different distributions (e.g. 2,436 deliveries filed as 8595 "WNBA Metallic Gold
-- LE Standard" are, on chain, 8601 "… Trade Ticket Pack"). Only 289 were copies of the old wrong rip
-- guess. Secondary sales are of the same NFTs. So the NFT's chain dist IS what was bought or
-- delivered, and the chain is authoritative for purchases as for rips (20261004180000).
--
-- WHAT. (1) Backup table public.audit_20261004_pack_purchases_dist_rekey_backup (RLS on, access
-- revoked, first old value per purchase row kept). (2) Re-key every Top Shot purchase whose chain
-- dist (not NULL, not '0', a known pack_distributions row) differs: 4,208 rows at 11:25 AM PT.
-- (3) rekey_pack_rips_to_chain_identity() now also re-keys purchases for identities checked in the
-- last hour. No trigger on pack_purchases reads pack_dist_id. The rips -> purchases trigger fills
-- only NULLs, so the two repairs cannot fight.
-- anon-exec: revoked (rekey_pack_rips_to_chain_identity) — unchanged; SECURITY DEFINER writer, pg_cron + service_role only.
--
-- REVERT: UPDATE public.pack_purchases p SET pack_dist_id = b.old_dist_id
--   FROM public.audit_20261004_pack_purchases_dist_rekey_backup b WHERE p.id = b.purchase_id;
--   and re-apply the function body from 20261004181500.

CREATE TABLE IF NOT EXISTS public.audit_20261004_pack_purchases_dist_rekey_backup (
  purchase_id uuid PRIMARY KEY,
  pack_nft_id text NOT NULL,
  old_dist_id text,
  new_dist_id text NOT NULL,
  rekeyed_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261004_pack_purchases_dist_rekey_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_pack_purchases_dist_rekey_backup FROM PUBLIC, anon, authenticated;

WITH target AS (
  SELECT p.id, p.pack_nft_id, p.pack_dist_id AS old_dist_id, i.dist_id AS new_dist_id
  FROM public.pack_purchases p
  JOIN public.pack_nft_identity i ON i.collection_id = p.collection_id AND i.pack_nft_id = p.pack_nft_id
  WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND p.pack_dist_id IS NOT NULL
    AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
    AND i.dist_id <> p.pack_dist_id
    AND EXISTS (SELECT 1 FROM public.pack_distributions d
                 WHERE d.collection_id = p.collection_id AND d.dist_id = i.dist_id)
), saved AS (
  INSERT INTO public.audit_20261004_pack_purchases_dist_rekey_backup (purchase_id, pack_nft_id, old_dist_id, new_dist_id)
  SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
  ON CONFLICT (purchase_id) DO NOTHING
  RETURNING purchase_id
)
UPDATE public.pack_purchases p
   SET pack_dist_id = t.new_dist_id
  FROM target t
 WHERE p.id = t.id;

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

  PERFORM public.log_pipeline_run('pack-rips-chain-rekey', v_started, v_n + v_p, v_n + v_p, 0, true, NULL,
    'nba_top_shot', NULL, NULL, jsonb_build_object('rekeyed', v_n, 'purchases_rekeyed', v_p));
  RETURN jsonb_build_object('ok', true, 'rekeyed', v_n, 'purchases_rekeyed', v_p);
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
