-- audit_20260731_sales_tx_collision_loss_view
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260731145535, verbatim. The originating Cowork session applied this via the
-- Supabase MCP, which writes only to schema_migrations -- never a repo file and
-- never the ledger -- so prod carried this view with no revert path on disk.
-- See docs/overnight/ledger.md 2026-07-31 for the recovery entry.
--
-- Revert: DROP VIEW IF EXISTS public.v_sales_tx_collision_loss;

CREATE OR REPLACE VIEW public.v_sales_tx_collision_loss AS
SELECT c.slug AS collection_slug,
       count(*)::bigint                                              AS blocked_rows,
       count(DISTINCT us.transaction_hash)::bigint                   AS blocked_tx,
       round(COALESCE(sum(us.price_usd), 0), 2)                      AS blocked_usd,
       count(*) FILTER (WHERE us.sold_at > now() - interval '30 days')::bigint AS blocked_rows_30d,
       min(us.sold_at)                                               AS oldest_blocked_at,
       max(us.sold_at)                                               AS newest_blocked_at
FROM public.unmapped_sales us
JOIN public.collections c ON c.id = us.collection_id
WHERE us.resolved_at IS NULL
  AND COALESCE(us.resolution_hint ->> 'promote_blocked', '') = 'sales_tx_hash_unique_collision'
GROUP BY c.slug;

ALTER VIEW public.v_sales_tx_collision_loss SET (security_invoker = on);
REVOKE ALL ON public.v_sales_tx_collision_loss FROM anon;

COMMENT ON VIEW public.v_sales_tx_collision_loss IS
'Sales that exist on chain and are fully edition-resolvable, but CANNOT be stored: idx_sales_tx_hash is UNIQUE on (transaction_hash, sold_at), so a multi-item transaction can hold exactly ONE row in public.sales. Every other item in that transaction is rejected by ON CONFLICT DO NOTHING in promote_unmapped_sales(), marked promote_blocked=sales_tx_hash_unique_collision, and re-checked in 30 days -- forever, because the collision is structural, not transient.
Verified 2026-07-31: 0 transaction_hashes in public.sales have >1 row over 90d. On nfl_all_day, 2,955 multi-item transactions hold 9,823 unmapped rows, of which 6,868 (~$30k) are unstorable under the current index.
Prices here are per-item, NOT a replicated transaction total -- tested: mean price does not scale with item count (n=2 $4.50 / n=3 $4.03 / n=4 $4.58) and the max uniform price FALLS with n (10/10/8). Zero intra-transaction price variance across all 2,955 txs is a floor-sweep artifact (1,758 sit at the $2 AllDay minimum), not a decoder fault. So these rows are real sales being dropped, not bad data being correctly rejected.
FIX belongs in the index, not the resolver: widening idx_sales_tx_hash to (transaction_hash, nft_id, sold_at) is what unblocks them. Until then this loss is an accepted, measured floor -- which is why unmapped_resolution_backlog_max excludes it (see audit_20260731_backlog_metric_excludes_structural_collisions).';
