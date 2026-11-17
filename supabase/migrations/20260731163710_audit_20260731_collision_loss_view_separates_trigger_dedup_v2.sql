-- audit_20260731_collision_loss_view_separates_trigger_dedup_v2
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260731163710, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. SUPERSEDES audit_20260731_sales_tx_collision_loss_view
-- (20260731145535) -- this is the definition prod actually runs, and it is the
-- object the 2026-07-31 multi-item-index ledger entry names as its verification
-- target. See docs/overnight/ledger.md 2026-07-31.
--
-- Revert: DROP VIEW IF EXISTS public.v_sales_tx_collision_loss; then re-apply
-- 20260731145535 for the prior (single-column, cause-less) body.

-- DROP + CREATE (not REPLACE): the column list changes, and CREATE OR REPLACE
-- cannot rename view columns. Verified 0 dependent views/rules before dropping.
DROP VIEW IF EXISTS public.v_sales_tx_collision_loss;

CREATE VIEW public.v_sales_tx_collision_loss AS
SELECT c.slug AS collection_slug,
       CASE
         WHEN EXISTS (SELECT 1 FROM public.sales s
                       WHERE s.transaction_hash = us.transaction_hash
                         AND s.nft_id IS DISTINCT FROM us.nft_id)
           THEN 'tx_hash_index_collision'
         WHEN EXISTS (SELECT 1 FROM public.sales s
                       WHERE s.collection_id = us.collection_id
                         AND s.nft_id = us.nft_id
                         AND date_trunc('day', s.sold_at) = date_trunc('day', us.sold_at)
                         AND round(s.price_usd, 2) = round(us.price_usd, 2)
                         AND s.source IS DISTINCT FROM us.source)
           THEN 'cross_source_dedup_trigger'
         ELSE 'unexplained'
       END                                          AS cause,
       count(*)::bigint                             AS rows_marked,
       count(DISTINCT us.transaction_hash)::bigint  AS distinct_tx,
       round(COALESCE(sum(us.price_usd), 0), 2)     AS usd,
       min(us.sold_at)                              AS oldest,
       max(us.sold_at)                              AS newest
FROM public.unmapped_sales us
JOIN public.collections c ON c.id = us.collection_id
WHERE us.resolved_at IS NULL
  AND COALESCE(us.resolution_hint ->> 'promote_blocked', '') = 'sales_tx_hash_unique_collision'
GROUP BY c.slug, 2;

ALTER VIEW public.v_sales_tx_collision_loss SET (security_invoker = on);
REVOKE ALL ON public.v_sales_tx_collision_loss FROM anon;

COMMENT ON VIEW public.v_sales_tx_collision_loss IS
'Rows promote_unmapped_sales() parked as promote_blocked=sales_tx_hash_unique_collision. Read the cause column, NOT the marker -- the marker is now a misnomer.
tx_hash_index_collision: a genuine same-transaction sibling already occupies public.sales. This was the original defect (one row per transaction under the old UNIQUE (transaction_hash, sold_at)) and is FIXED as of 2026-07-31 by idx_sales_tx_nft_sold UNIQUE (transaction_hash, nft_id, sold_at) NULLS NOT DISTINCT, built CONCURRENTLY across all 8 partitions, plus dropping a stricter parent-less transaction_hash-only index that sales_2026 carried on its own. Expect 0 here; anything above 0 is a regression.
cross_source_dedup_trigger: the BEFORE INSERT trigger allday_sales_cross_source_dedup() found a cross-source twin (same nft, same calendar day, same rounded price, different source), merged the incoming buyer/seller/serial into it, and RETURNed NULL. The sale IS recorded -- on the twin. These rows are resolved in substance but promote_unmapped_sales() cannot tell a suppressed insert from a collision (its ELSE branch assumes collision), so it parks them for 30 days and they recycle forever. The fix belongs in the function: detect the twin and mark resolved. Until then this is cosmetic, not loss.
unexplained: neither pattern matches. Investigate before assuming either cause.';
