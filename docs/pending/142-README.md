# #142 — one step left: the 168-row quarantine (NOT APPLIED)

Applied and live-verified 2026-11-01 (no confirmation prompt — only DROP/DELETE
trigger Supabase's prompt, which never reaches the cloud session):
`20261101145804` (export_wallet_csv, backfill_cost_basis_from_ids,
backfill_pinnacle_mint_acquisitions) and `20261101145940`
(get_wallet_acquisition_data_scoped, which /api/wallet-search and /api/cost-basis
now call).

**Still to run, by hand in the Supabase SQL editor:**
`142-quarantine-run-in-sql-editor.sql` — moves the 168 `sales_backfill` rows that
were priced from an All Day / UFC sale ($1,678.51) into
`moment_acquisitions_xcoll_quarantine`, in one statement. Restore statement in its
header. It DELETEs, so `apply_migration` stops on the confirmation prompt.

After it runs: a session checks the quarantine has 168 rows and no matching rows
remain in moment_acquisitions, logs it in the ledger, and deletes this folder.
(The SQL editor writes no schema_migrations row, so migration-parity has nothing
to flag and no file is needed.)

Also left for a session that can answer a DROP prompt: drop the now-uncalled
`get_wallet_acquisition_data(text, text[])`.
