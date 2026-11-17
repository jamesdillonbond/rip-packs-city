-- 2026-10-04 (PT) — remove 7 duplicate Top Shot sales written twice on 2026-10-04 ~2:00–3:00 PM PT.
-- Cause: the walk lane (promote_flowty_chain_sales → source flowty_chain_v1) and the mainnet24 tx lane
-- (promote_flowty_tx_verified_sales → flowty_chain_tx_v1) re-ran concurrently over the same mainnet24 era; each
-- checks "already in sales" before inserting, so two ticks in flight both passed the check for the same sale.
-- Every pair: same transaction_hash, nft_id, price and serial (sold_at differs only in sub-ms precision).
-- Keeps the walk-lane row (flowty_chain_v1); removes the tx-lane copy. A copy of each removed row is kept in
-- flowty_archive.audit_20261004_tx_lane_dupes. The tx lane (pg_cron 708) was unscheduled at ~3:02 PM PT and is
-- resumed only after the walk lane has finished, so the two never run together again.
-- Revert: INSERT INTO public.sales SELECT * FROM flowty_archive.audit_20261004_tx_lane_dupes;

BEGIN;
CREATE TABLE flowty_archive.audit_20261004_tx_lane_dupes AS
SELECT t.* FROM public.sales t
WHERE t.source = 'flowty_chain_tx_v1'
  AND EXISTS (SELECT 1 FROM public.sales w
              WHERE w.source = 'flowty_chain_v1' AND w.collection = t.collection
                AND w.transaction_hash = t.transaction_hash AND w.nft_id = t.nft_id);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM flowty_archive.audit_20261004_tx_lane_dupes;
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 duplicate tx-lane rows, found % — stop and re-check', n; END IF;
END $$;

DELETE FROM public.sales t USING flowty_archive.audit_20261004_tx_lane_dupes d
WHERE t.id = d.id AND t.source = 'flowty_chain_tx_v1';
COMMIT;
