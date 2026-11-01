# #142 — one paste left: 164-row quarantine + drop the old read (NOT APPLIED)

Applied and live-verified 2026-11-01 (no confirmation prompt — only DROP/DELETE
trigger Supabase's prompt, which never reaches the cloud session):
`20261101145804` (export_wallet_csv, backfill_cost_basis_from_ids,
backfill_pinnacle_mint_acquisitions) and `20261101145940`
(get_wallet_acquisition_data_scoped, which /api/wallet-search and /api/cost-basis
now call).

**Still to run, by hand in the Supabase SQL editor:**
`142-quarantine-run-in-sql-editor.sql` — (1) moves the 164 `sales_backfill` rows
priced from an All Day / UFC sale the wallet never made ($1,673.51; the 4 real
All Day purchases among the original 168 were re-tagged in 20261101152422) into
`moment_acquisitions_xcoll_quarantine`, in one statement. Restore statement in its
header; (2) drops the uncalled `get_wallet_acquisition_data(text, text[])`. It
DELETEs and DROPs, so `apply_migration` stops on the confirmation prompt.

After it runs: a session checks the quarantine has 164 rows, the old function is gone, and no matching rows
remain in moment_acquisitions, logs it in the ledger, and deletes this folder.
(The SQL editor writes no schema_migrations row, so migration-parity has nothing
to flag and no file is needed.)

