-- 2026-10-04 (PT) — Top Shot pack_rips.dist_id re-keyed to the CHAIN's answer where the two disagree.
--
-- WHY. inbox/2026-10-04T1627Z-pack-rips-dist-inferred-wrong-65k-rips-sink-dists.md: 65,477 Top Shot
-- rips carry a dist_id that backfill_pack_rip_metadata INFERRED from pulled editions (a pool vote).
-- Every writer of the column only fills a NULL, so a wrong vote was permanent. A few dists act as
-- sinks (8552, a set-completion REWARD pack, held 27.5 k other packs' rips). Pack pages miscount
-- opens, depletion and realized EV as a result. The disputed packs were queued for chain identity
-- (Dapper searchPackNft via the pack_nft_identity lane, pg_cron 509) at 9:27 AM PT.
--
-- WHY THE CHAIN, AND ONLY THE CHAIN. For a RIP there is no ambiguity: the opened pack IS the NFT,
-- and pack_nft_identity.dist_id is that NFT's distribution. The early verification refuted the
-- alternative: on disputed rows the chain sided with pack_purchases.pack_dist_id 59 times, with
-- the rip 0 times, and with neither 533 times. So copying the purchase table would only move the
-- error. pack_purchases is NOT touched here. Its trigger path (pack_rips_propagate_dist_trg) fills
-- only a NULL pack_dist_id, so re-keying a rip cannot overwrite a purchase.
--
-- SCOPE (checked before running): Top Shot only; rows where pack_nft_identity has a real dist
-- (not NULL, not '0') that differs from pack_rips.dist_id. At 10:58 AM PT that was 6,262 rows from 60
-- dists to 53, and every target dist exists in pack_distributions. None had a dapper_index
-- attribution. RE-RUNNABLE: later runs pick up rows verified since. The backup keeps each rip's
-- FIRST pre-repair value (ON CONFLICT DO NOTHING), so a re-run can never record a repaired value as
-- the "old" one.
--
-- REVERT (all runs): UPDATE public.pack_rips r SET dist_id = b.old_dist_id
--   FROM public.audit_20261004_pack_rips_dist_rekey_backup b WHERE r.id = b.rip_id;

CREATE TABLE IF NOT EXISTS public.audit_20261004_pack_rips_dist_rekey_backup (
  rip_id      uuid PRIMARY KEY,
  pack_nft_id text NOT NULL,
  old_dist_id text,
  new_dist_id text NOT NULL,
  rekeyed_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261004_pack_rips_dist_rekey_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_pack_rips_dist_rekey_backup FROM PUBLIC, anon, authenticated;

WITH target AS (
  SELECT r.id, r.pack_nft_id, r.dist_id AS old_dist_id, i.dist_id AS new_dist_id
  FROM public.pack_rips r
  JOIN public.pack_nft_identity i ON i.collection_id = r.collection_id AND i.pack_nft_id = r.pack_nft_id
  WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND r.dist_id IS NOT NULL
    AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
    AND i.dist_id <> r.dist_id
    AND EXISTS (SELECT 1 FROM public.pack_distributions d
                 WHERE d.collection_id = r.collection_id AND d.dist_id = i.dist_id)
), saved AS (
  INSERT INTO public.audit_20261004_pack_rips_dist_rekey_backup (rip_id, pack_nft_id, old_dist_id, new_dist_id)
  SELECT id, pack_nft_id, old_dist_id, new_dist_id FROM target
  ON CONFLICT (rip_id) DO NOTHING
  RETURNING rip_id
)
UPDATE public.pack_rips r
   SET dist_id = t.new_dist_id
  FROM target t
 WHERE r.id = t.id;
