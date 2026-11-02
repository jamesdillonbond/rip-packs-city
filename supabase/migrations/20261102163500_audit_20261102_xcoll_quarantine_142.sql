-- APPLIED 2026-11-02 ~8:45 AM PT via the dashboard SQL editor (Cowork cloud, Chrome; Trevor: "Take care of these").
-- Verbatim copy of docs/pending/142-quarantine-run-in-sql-editor.sql (moved here). Verified after: falsifier 0,
-- quarantine 164 rows / $1,673.51, get_wallet_acquisition_data(text, text[]) gone, RLS on, anon SELECT false.

-- Quarantine the 164 cost-basis rows priced from ANOTHER collection's sale
-- (2026-10-31; the writer was fixed in the preceding migration).
--
-- backfill_cost_basis_from_ids looked the moment's last sale up in `sales` by
-- nft_id alone and tagged the row with p_collection_id (default Top Shot). An
-- All Day or UFC sale of the same id therefore became a Top Shot moment's
-- purchase. Measured 2026-10-31: 168 of its 755 rows (source='sales_backfill')
-- are tagged Top Shot while their transaction_hash + nft_id match ONLY a sale in
-- another collection: 66 from All Day, 102 from UFC, $1,678.51 of spend that
-- never happened, across ~95 wallets.
--
-- UPDATE 2026-11-01: 4 of the 168 were REAL All Day purchases by the same wallet
-- (buyer_address = wallet, still held) and were re-tagged instead
-- (20261101152422). The WHERE below no longer matches them, so this moves the
-- remaining 164 ($1,673.51), verified live just before this file was written.
-- Every one feeds Paid / cost basis / P&L
-- and acquisition stats. Newest row 2026-08-26; nothing has written one since.
--
-- MOVED, NOT DELETED: each row is copied verbatim into
-- moment_acquisitions_xcoll_quarantine (plus the sale's real collection and the
-- time it moved) in the SAME statement that deletes it, so nothing can be lost
-- between the two.
--
-- REVERT:
--   INSERT INTO public.moment_acquisitions (
--     id, nft_id, wallet, buy_price, acquired_date, acquired_type, fmv_at_acquisition,
--     seller_address, transaction_hash, source, created_at, collection_id, acquisition_method,
--     source_wallet, loan_principal, pack_dist_id, fmv_at_receipt, acquisition_confidence,
--     source_address, source_pack_rip_id)
--   SELECT
--     id, nft_id, wallet, buy_price, acquired_date, acquired_type, fmv_at_acquisition,
--     seller_address, transaction_hash, source, created_at, collection_id, acquisition_method,
--     source_wallet, loan_principal, pack_dist_id, fmv_at_receipt, acquisition_confidence,
--     source_address, source_pack_rip_id
--   FROM public.moment_acquisitions_xcoll_quarantine;

CREATE TABLE IF NOT EXISTS public.moment_acquisitions_xcoll_quarantine
  (LIKE public.moment_acquisitions);
ALTER TABLE public.moment_acquisitions_xcoll_quarantine
  ADD COLUMN IF NOT EXISTS sale_collection_id uuid,
  ADD COLUMN IF NOT EXISTS quarantined_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS quarantine_reason text;
ALTER TABLE public.moment_acquisitions_xcoll_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moment_acquisitions_xcoll_quarantine FROM anon, authenticated;
COMMENT ON TABLE public.moment_acquisitions_xcoll_quarantine IS
  'moment_acquisitions rows removed 2026-10-31 because they were priced from another collection''s sale (#142). Verbatim copies; restore by inserting back.';

WITH moved AS (
  DELETE FROM public.moment_acquisitions ma
   WHERE ma.source = 'sales_backfill'
     AND EXISTS (SELECT 1 FROM public.sales s
                  WHERE s.transaction_hash = ma.transaction_hash AND s.nft_id = ma.nft_id
                    AND s.collection_id <> ma.collection_id)
     AND NOT EXISTS (SELECT 1 FROM public.sales s
                      WHERE s.transaction_hash = ma.transaction_hash AND s.nft_id = ma.nft_id
                        AND s.collection_id = ma.collection_id)
  RETURNING ma.*
)
INSERT INTO public.moment_acquisitions_xcoll_quarantine
SELECT moved.*,
       (SELECT s.collection_id FROM public.sales s
         WHERE s.transaction_hash = moved.transaction_hash AND s.nft_id = moved.nft_id
         LIMIT 1),
       now(),
       'sales_backfill priced from another collection''s sale (#142)'
  FROM moved;

-- ── 2. Drop the superseded, uncalled get_wallet_acquisition_data(text, text[]) ──
-- Replaced by get_wallet_acquisition_data_scoped (20261101145940), which both of
-- its callers (/api/wallet-search, /api/cost-basis) use since d749e0711. Verified
-- 2026-11-01: no repo code, DB function, view or pg_cron job references it; it is
-- service_role-only, so nothing anonymous can be calling it.
DROP FUNCTION IF EXISTS public.get_wallet_acquisition_data(text, text[]);
