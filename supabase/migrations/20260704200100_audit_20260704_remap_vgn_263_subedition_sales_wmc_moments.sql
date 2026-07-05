-- Re-key the 362 Video Game Numbers (set 263) parallel moments (Hexwave/Jukebox) off the
-- base edition onto their `::subID` edition, across sales + wallet_moments_cache + moments.
-- Companion to 20260704200000 (catalog). Fixes the parallel conflation found in the
-- 2026-07-04 QA (parallel sales inflating base FMV; wrong supply on moment pages).
--
-- Mapping source = topshot_moment_subeditions (nft_id -> base_external_id/subedition_id,
-- resolved on-chain via TopShot.getMomentsSubedition). Idempotent (only moves rows still on
-- the base edition). Applied result: 139 sales, 243 wmc, 263 moments re-keyed; 0 parallel
-- nfts left on base; security invariants 0, fmv_sanity 0, trust-health all ok.
--
-- Revert (deterministic): re-key back to base via topshot_moment_subeditions, then run the
-- catalog migration revert. Example (sales):
--   UPDATE sales s SET edition_id = b.id
--   FROM topshot_moment_subeditions t
--   JOIN editions b ON b.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND b.external_id=t.base_external_id
--   JOIN editions cur ON cur.id=s.edition_id
--   WHERE s.nft_id=t.nft_id AND cur.external_id=t.base_external_id||'::'||t.subedition_id AND t.base_external_id ~ '^263:';

UPDATE sales s SET edition_id = tgt.id
FROM topshot_moment_subeditions t
JOIN editions tgt ON tgt.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND tgt.external_id = t.base_external_id||'::'||t.subedition_id
JOIN editions cur ON cur.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND cur.external_id = t.base_external_id
WHERE s.nft_id = t.nft_id AND s.edition_id = cur.id AND t.base_external_id ~ '^263:[0-9]+$';

UPDATE wallet_moments_cache wm
SET edition_key = t.base_external_id||'::'||t.subedition_id,
    mint_count = CASE t.subedition_id WHEN 19 THEN 25 WHEN 20 THEN 10 END
FROM topshot_moment_subeditions t
WHERE wm.moment_id = t.nft_id
  AND wm.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND wm.edition_key = t.base_external_id
  AND t.base_external_id ~ '^263:[0-9]+$';

UPDATE moments m SET edition_id = tgt.id
FROM topshot_moment_subeditions t
JOIN editions tgt ON tgt.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND tgt.external_id = t.base_external_id||'::'||t.subedition_id
JOIN editions cur ON cur.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND cur.external_id = t.base_external_id
WHERE m.nft_id = t.nft_id AND m.edition_id = cur.id AND t.base_external_id ~ '^263:[0-9]+$';
