# Cowork handoff — apply the Atlas sale-twin fix (2026-11-25)

**From:** Claude Code cloud, 11-25 ~5:50 PM PT. **Trevor:** "Apply twins" → "Hand it to cowork". Three `apply_migration` attempts from the cloud session timed out on the approval prompt (it deletes production rows), so nothing has changed yet.

## What it does

231 Top Shot sales are stored twice: an `atlas` row (no tx hash) plus the on-chain row for the same sale (same nft, price, seller, buyer), 10–93 min apart. The existing `retire_topshot_atlas_sale_twins` (pg_cron jobid 716, every 6 h) only matches within ±10 min, so it retires none of them. 155 come from the 10-29 post-outage catch-up and 7 from 11-23. One inflated the 11-25 rookie-class total by $19.

The fix widens the match to ±2 h **only** when seller and buyer also match and no other sale of that moment sits between the two rows. Then it runs one all-time sweep. Every deleted row is archived whole in `flowty_archive.audit_topshot_atlas_sale_twins`.

File: `docs/proposals/20261125175500_audit_20261125_atlas_sale_twins_match_seller_buyer_within_2h-STAGED.sql` (header has cause, evidence and revert).

## Steps

1. **Pre-check (base unchanged):**
   `select md5(prosrc) from pg_proc where proname='retire_topshot_atlas_sale_twins';` must be `3c9eaf9bad69540acf80f44b596b2c90`. If not, stop: someone changed it, so re-diff before applying.
2. **Dry count:** expect ~231 (it may differ by a few as new sales land):
   ```sql
   select count(*) from sales a where a.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' and a.source='atlas' and a.transaction_hash is null
     and exists (select 1 from sales o where o.collection_id=a.collection_id and o.nft_id=a.nft_id and o.id<>a.id
       and o.source is distinct from 'atlas' and o.transaction_hash is not null and o.price_usd=a.price_usd
       and o.seller_address=a.seller_address and o.buyer_address=a.buyer_address
       and o.sold_at between a.sold_at - interval '2 hours' and a.sold_at + interval '2 hours'
       and not exists (select 1 from sales m where m.collection_id=a.collection_id and m.nft_id=a.nft_id and m.id not in (a.id,o.id)
         and m.sold_at between least(a.sold_at,o.sold_at) and greatest(a.sold_at,o.sold_at)));
   ```
3. **Apply:** `apply_migration` with name `audit_20261125_atlas_sale_twins_match_seller_buyer_within_2h`, query = the file from `CREATE OR REPLACE FUNCTION` to the end (includes `SELECT public.retire_topshot_atlas_sale_twins(3000);`). Needs Trevor's approval click.
4. **Post-checks:**
   - The sweep's returned jsonb: `error` null, `retired` = `twins_found` ≈ the dry count.
   - `select count(*) from flowty_archive.audit_topshot_atlas_sale_twins where retired_at > now() - interval '1 hour'` = `retired`.
   - Re-run the dry count: 0.
   - `has_function_privilege('anon','public.retire_topshot_atlas_sale_twins(integer)','execute')` = false.
   - Rookie class check: total `sales` rows for the 38-rookie cohort drop by 1 (Christian Anderson Jr. $19 twin).
5. **Repo:** `git mv` the STAGED file to `supabase/migrations/20261125175500_audit_20261125_atlas_sale_twins_match_seller_buyer_within_2h.sql`. Add an `✅ APPLIED <PT time> (recorded version <v>)` line under its first header line. Write the ledger entry first (splice at the first `^### `; date · what · revert), then commit the migration as the tip, and push to main.

## Revert

- Re-apply the function body from `supabase/migrations/20261010053000_audit_20261009_atlas_sale_twins_retired_when_the_onchain_row_lands_late.sql` (CREATE OR REPLACE only; the cron job is unchanged).
- Restore the rows:
  ```sql
  INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, a.row)).*
    FROM flowty_archive.audit_topshot_atlas_sale_twins a WHERE a.retired_at >= '2026-11-25';
  ```

## Already done (no action)

- ESPN box-score re-read: applied 20261126011219, pushed. Peterson's line is now correct on the live API.
- The Wednesday X draft script now checks every stat line against ESPN; the daily draft task subtracts twins by hand until this lands.
