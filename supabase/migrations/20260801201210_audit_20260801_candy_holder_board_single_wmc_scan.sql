-- THIRD and final iteration on the LIVE /insights/candy-mlb Holders tab (was
-- rendering "Holders 0" against 373 real collectors).
--   v1 (scope the fmv_current join)      82.3s -> 2.9s with ORDER BY ... LIMIT 50,
--                                        but the page's bare `LIMIT 200` still timed out.
--   v2 (MATERIALIZED CTEs to pin plan)   40.8s — plan stable, still too slow.
-- Remaining cost was I/O, not planning: `wallet_moments_cache` was scanned TWICE
-- (once to resolve the treasury wallet, once for the per-edition lookup driven
-- 125x through idx_wmc_coll_ek_serial_cover), costing ~15.7k COLD disk reads /
-- ~41k buffers on a Micro instance.
--
-- v3: read wmc EXACTLY ONCE. The treasury wallet is derived from that same scan
-- rather than a second one, and the edition->FMV map is pre-collapsed to 125 rows
-- keyed by edition_key so the join needs no per-row index probe.
-- Output columns byte-identical.
CREATE OR REPLACE VIEW public.candy_holder_board AS
WITH held AS MATERIALIZED (
  -- the ONLY read of wallet_moments_cache
  SELECT wallet_address, edition_key
    FROM wallet_moments_cache
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
), treas AS MATERIALIZED (
  -- treasury = largest holder, derived from the scan above (no second read)
  SELECT wallet_address FROM held GROUP BY wallet_address ORDER BY count(*) DESC LIMIT 1
), key_fmv AS MATERIALIZED (
  -- 125 rows: edition_key -> latest Candy FMV. Scoped to the Candy partition slice,
  -- NOT the global fmv_current DISTINCT ON over ~944k snapshot rows.
  SELECT e.external_id::text AS edition_key, c.fmv_usd
    FROM editions e
    LEFT JOIN (
      SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
        FROM fmv_snapshots
       WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
       ORDER BY edition_id, computed_at DESC
    ) c ON c.edition_id = e.id
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
)
SELECT h.wallet_address,
       count(*)                                      AS serials,
       count(DISTINCT h.edition_key)                 AS editions,
       round(sum(k.fmv_usd), 2)                      AS est_fmv_usd,
       count(*) FILTER (WHERE k.fmv_usd IS NOT NULL) AS priced_serials
  FROM held h
  LEFT JOIN key_fmv k ON k.edition_key = h.edition_key
 WHERE h.wallet_address <> (SELECT wallet_address FROM treas)
 GROUP BY h.wallet_address;

ALTER VIEW public.candy_holder_board SET (security_invoker = on);
REVOKE SELECT ON public.candy_holder_board FROM anon, authenticated;