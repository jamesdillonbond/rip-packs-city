-- 2026-11-14 (~5:30 PM PT, Cowork cloud). Trevor's 5:19 PM PT rule (pack cost lives on the pack; a pulled moment
-- costs $0 on the moment side), applied to his own wallet's existing rows: every 0xbd94cade097e50ac pack_pull row with
-- buy_price NULL -> 0. The estate-wide backfill (~1.15M rows across ~10k wallets) is NOT done here — held for Trevor's
-- go-ahead; new rows everywhere already land at 0 through trg_moment_acq_pack_pull_zero_cost (20261115013000).
-- Revert: UPDATE moment_acquisitions m SET buy_price = NULL
--         FROM flowty_archive.moment_acquisitions_pack_pull_null_ids_0xbd94_20261114 b WHERE m.id = b.id;
CREATE TABLE IF NOT EXISTS flowty_archive.moment_acquisitions_pack_pull_null_ids_0xbd94_20261114 AS
SELECT id FROM moment_acquisitions
WHERE wallet = '0xbd94cade097e50ac' AND acquisition_method = 'pack_pull' AND buy_price IS NULL;
REVOKE ALL ON flowty_archive.moment_acquisitions_pack_pull_null_ids_0xbd94_20261114 FROM PUBLIC, anon, authenticated;

UPDATE moment_acquisitions m SET buy_price = 0
FROM flowty_archive.moment_acquisitions_pack_pull_null_ids_0xbd94_20261114 b WHERE b.id = m.id;
