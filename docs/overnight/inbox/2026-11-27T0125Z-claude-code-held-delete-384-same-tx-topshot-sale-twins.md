# Held DELETE: 384 Top Shot sales stored twice under the same transaction hash (Claude Code cloud, 2026-11-26 ~5:25 PM PT)

**Status: NOT APPLIED.** `apply_migration` held the DELETE for confirmation and the prompt timed out (the session was
running autonomously). Read back after: no `schema_migrations` row, no archive table. Nothing changed.

**What (MEDIUM, data accuracy):** 384 Top Shot sales from 2026-03-23..30 exist twice with the SAME `transaction_hash`:
a `topshot_marketplace` row with `nft_id` NULL and a `dapper_chain_tx_v1` row with `nft_id` set (same edition, serial,
price, seller, buyer; 1–6 s apart). $1,841.67 of volume is double-counted. Neither row is `atlas`, so
`retire_topshot_atlas_sale_twins` never sees them; the `(tx, nft_id, …)` unique indexes miss them because one side's
`nft_id` is NULL. Found the same evening as the 2,487 Atlas twins of the same March load, which WERE retired
(`20261127012030`, ledger 5:22 PM PT).

**Measured 11-26 ~5:24 PM PT:** exactly 384 pairs / 384 distinct duplicates; every keeper is `dapper_chain_tx_v1` with
`nft_id`; 0 `unmapped_sales` / `sales_ingest_unresolved` rows reference a duplicate.

## To apply (SQL editor, or an attended `apply_migration` with this exact name)

Name: `audit_20261126_topshot_marketplace_same_tx_twins_retired`. The body is below, verbatim. Then commit it as
`supabase/migrations/<version>_audit_20261126_topshot_marketplace_same_tx_twins_retired.sql` under the version prod
assigns, and add a ledger line.

```sql
-- 2026-11-26 (Claude Code cloud, autonomous pass). 384 Top Shot sales from 2026-03-23..30 were stored twice with
-- the SAME transaction hash: a `topshot_marketplace` row (nft_id NULL) and a `dapper_chain_tx_v1` row (nft_id set),
-- same edition, serial, price, seller and buyer, 1-6 s apart. Neither is an `atlas` row, so
-- retire_topshot_atlas_sale_twins never looks at them; the unique indexes (tx, nft_id, …) cannot catch them because
-- one side's nft_id is NULL. Found while retiring the March Atlas twins (20261127012030): same window, same cause
-- (the March topshot_marketplace load wrote no nft_id). $1,841.67 of sale volume was double-counted.
--
-- MEASURED: exactly 384 pairs, 384 distinct duplicates, every keeper is dapper_chain_tx_v1 with nft_id, and no
-- unmapped_sales / sales_ingest_unresolved row references a duplicate. The NFT-less row carries nothing the keeper
-- lacks (same tx, price, parties; the keeper adds nft_id).
--
-- FIX: delete the NFT-less duplicates and archive each whole, in one statement (the retire_topshot_atlas_sale_twins
-- shape), into flowty_archive.audit_20261126_topshot_marketplace_same_tx_twins.
--
-- REVERT: INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, a.row)).*
--   FROM flowty_archive.audit_20261126_topshot_marketplace_same_tx_twins a;
CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261126_topshot_marketplace_same_tx_twins (
  sale_id uuid NOT NULL,
  twin_id uuid NOT NULL,
  row jsonb NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_id)
);
REVOKE ALL ON flowty_archive.audit_20261126_topshot_marketplace_same_tx_twins FROM PUBLIC, anon, authenticated;

WITH p AS (
  SELECT t.id AS tid, t.sold_at AS tsold, k.id AS kid
    FROM public.sales t
    JOIN public.sales k
      ON k.transaction_hash = t.transaction_hash AND k.id <> t.id AND k.nft_id IS NOT NULL
     AND k.collection_id = t.collection_id AND k.edition_id = t.edition_id
     AND k.serial_number IS NOT DISTINCT FROM t.serial_number AND k.price_usd = t.price_usd
     AND k.seller_address IS NOT DISTINCT FROM t.seller_address AND k.buyer_address IS NOT DISTINCT FROM t.buyer_address
     AND k.source = 'dapper_chain_tx_v1'
   WHERE t.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND t.source = 'topshot_marketplace' AND t.nft_id IS NULL AND t.transaction_hash IS NOT NULL
     AND t.sold_at >= '2026-03-22' AND t.sold_at < '2026-04-01'
), uniq AS (
  SELECT p.* FROM p WHERE (SELECT count(*) FROM p p2 WHERE p2.tid = p.tid) = 1
), d AS (
  DELETE FROM public.sales s
   USING uniq u
   WHERE s.id = u.tid AND s.sold_at = u.tsold
     AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND s.source = 'topshot_marketplace' AND s.nft_id IS NULL
  RETURNING s.*
)
INSERT INTO flowty_archive.audit_20261126_topshot_marketplace_same_tx_twins (sale_id, twin_id, row)
SELECT d.id, u.kid, to_jsonb(d) FROM d JOIN uniq u ON u.tid = d.id;
```

**Verify:** `select count(*) from flowty_archive.audit_20261126_topshot_marketplace_same_tx_twins` = 384, and the
pre-apply count query (the `p` CTE above with `count(*)`) returns 0.
