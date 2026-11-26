-- audit_20261126_topshot_offer_pull_restamp_ask_only_undo_over_180d — the one-off half of
-- audit_20261126_topshot_offer_pull_legendary_ask_only_skip_180d: the rows 20261126221106 lifted whose edition's
-- last market sale is more than 180 days old go back to the pulled price they had (the rule would pull them again
-- on their next recalc anyway). Dry run 2:59 PM PT: 98 of the 329. Only rows still at the lifted value are touched;
-- reverted_at marks them in the backup table.
-- REVERT: UPDATE public.fmv_snapshots fs SET fmv_usd = b.new_fmv_usd, algo_version = b.new_algo_version
--   FROM public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup b
--  WHERE fs.id = b.snapshot_id AND b.reverted_at IS NOT NULL AND fs.fmv_usd = b.old_fmv_usd;
ALTER TABLE public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup
  ADD COLUMN IF NOT EXISTS reverted_at timestamptz;

WITH tgt AS (
  SELECT b.snapshot_id
    FROM public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup b
   WHERE b.reverted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.sales_market s
                      WHERE s.edition_id = b.edition_id AND s.sold_at > now() - interval '180 days')
), upd AS (
  UPDATE public.fmv_snapshots fs
     SET fmv_usd = b.old_fmv_usd,
         algo_version = b.old_algo_version
    FROM public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup b
    JOIN tgt ON tgt.snapshot_id = b.snapshot_id
   WHERE fs.id = b.snapshot_id
     AND fs.computed_at >= now() - interval '7 days'
     AND fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND fs.confidence = 'ASK_ONLY'
     AND fs.fmv_usd = b.new_fmv_usd
  RETURNING fs.id
)
UPDATE public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup b
   SET reverted_at = now()
  FROM upd
 WHERE b.snapshot_id = upd.id;