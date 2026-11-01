# #142 DB half — PARKED, NOT APPLIED (2026-11-01)

Prod does NOT have these changes yet. Supabase's `apply_migration` confirmation
prompt (triggered by `DROP FUNCTION`) timed out three times from the cloud
session, so Trevor is running the SQL by hand in the Supabase SQL editor.

1. `142-1-functions-run-first.sql` — collection-scopes `get_wallet_acquisition_data`
   (new optional `p_collection_id`), `export_wallet_csv` (443 duplicated moments),
   `backfill_cost_basis_from_ids` (priced from other collections' sales),
   `backfill_pinnacle_mint_acquisitions` (latent).
2. `142-2-quarantine-run-second.sql` — moves the 168 `sales_backfill` rows priced
   from an All Day / UFC sale ($1,678.51) into `moment_acquisitions_xcoll_quarantine`.
   Restore statement is in its header.

`142-acquisition-scope-db-half.patch` is the full repo change that ships AFTER both
run: the two migration files under `supabase/migrations/`, two DB pins, drift-guard
entries, and the two call sites (`/api/wallet-search`, `/api/cost-basis`) that pass
`p_collection_id` — which 404s against the live function until step 1 runs.

After both run: `git apply docs/pending/142-acquisition-scope-db-half.patch`, verify
live prosrc = committed bodies (new md5s 37cdcb5f / cc5176bf / 4c626e4d / d33ecb74),
quarantine count = 168, preflight, push, then delete this folder.
