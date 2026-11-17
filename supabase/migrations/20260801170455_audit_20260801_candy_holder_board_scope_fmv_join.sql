-- FIX: /insights/candy-mlb Holders tab rendered EMPTY on the LIVE public board.
-- Cause: candy_holder_board joined `fmv_current`, whose DISTINCT ON materializes over
-- ALL ~944k fmv_snapshots rows before filtering to the 125 Candy editions. 82.3s execution
-- blew the request budget; the page's fetchView fail-soft returned [] => "Holders 0"
-- while the view actually holds 373 collectors. Same anti-pattern recorded 2026-08-01
-- (fmv_current join 11x worse than a scoped lookup).
-- Fix: scope the latest-FMV lookup to the Candy collection partition slice, and
-- pre-resolve the treasury wallet once. Output columns byte-identical.
CREATE OR REPLACE VIEW public.candy_holder_board AS
WITH treas AS (
  SELECT wallet_address
    FROM wallet_moments_cache
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   GROUP BY wallet_address
   ORDER BY count(*) DESC
   LIMIT 1
), cfmv AS (
  -- scoped to the Candy slice: 125 editions, uses
  -- fmv_snapshots_2026_collection_id_edition_id_computed_at_idx
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
    FROM fmv_snapshots
   WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   ORDER BY edition_id, computed_at DESC
), held AS (
  SELECT w.wallet_address, w.edition_key, e.id AS edition_id
    FROM wallet_moments_cache w
    JOIN editions e
      ON e.external_id::text = w.edition_key
     AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
   WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND w.wallet_address <> (SELECT wallet_address FROM treas)
)
SELECT h.wallet_address,
       count(*) AS serials,
       count(DISTINCT h.edition_key) AS editions,
       round(sum(fc.fmv_usd), 2) AS est_fmv_usd,
       count(*) FILTER (WHERE fc.fmv_usd IS NOT NULL) AS priced_serials
  FROM held h
  LEFT JOIN cfmv fc ON fc.edition_id = h.edition_id
 GROUP BY h.wallet_address;

ALTER VIEW public.candy_holder_board SET (security_invoker = on);
REVOKE SELECT ON public.candy_holder_board FROM anon, authenticated;