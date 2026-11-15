-- 2026-11-14 (~4:30 PM PT, Cowork cloud; Trevor: "we need to get everything here covered, along with pack opens").
-- Cost basis for moments Trevor (0xbd94cade097e50ac) pulled from Top Shot PackNFT packs whose price we
-- already hold: get_wallet_pack_history(…,'ripped') prices 103 of his 129 NFT rips (onchain / marketplace /
-- retail / retail_inferred), and pack_open_pulls names every pull of each. Each pull gets the pack's
-- price split evenly over the moments it pulled (buy_usd / moments_pulled, rounded to the cent).
-- Only packs with buy_usd > 0 and not opened out of a box; only rows with buy_price NULL are touched.
-- retail_inferred packs (bought inside the drop window, no buy row) land as confidence 'heuristic';
-- the rest as 'verified'. Preview: 241 pulls, 234 acquisition rows, all unpriced, $1,735.07 (a first preview read $1,822.24 off a different sum; re-measured with this exact join).
-- Snapshot of the pricing input: flowty_archive.nft_pack_pull_prices_20261114. Backup of touched rows:
-- flowty_archive.moment_acquisitions_bak_pack_pull_20261114.
-- Revert:
--   UPDATE moment_acquisitions m SET buy_price=b.buy_price, acquisition_method=b.acquisition_method,
--     pack_dist_id=b.pack_dist_id, source=b.source, acquisition_confidence=b.acquisition_confidence
--   FROM flowty_archive.moment_acquisitions_bak_pack_pull_20261114 b WHERE m.id=b.id;
CREATE TABLE IF NOT EXISTS flowty_archive.nft_pack_pull_prices_20261114 AS
WITH pages AS (SELECT generate_series(0, 3200, 200) AS o),
h AS (
  SELECT p FROM pages,
  jsonb_array_elements(public.get_wallet_pack_history('0xbd94cade097e50ac','nba_top_shot','ripped',200,o)->'packs') p
  WHERE p->>'rip_source' = 'rip' AND (p->>'buy_usd')::numeric > 0
    AND COALESCE((p->>'box_packs')::int, 0) = 0
)
SELECT p->>'pack_nft_id' AS pack_nft_id, p->>'dist_id' AS dist_id, (p->>'buy_usd')::numeric AS buy_usd,
       (p->>'moments_pulled')::int AS moments_pulled, p->>'buy_price_source' AS buy_price_source,
       op.nft_id, round((p->>'buy_usd')::numeric / (p->>'moments_pulled')::int, 2) AS cost_per_pull
FROM h JOIN pack_open_pulls op
  ON op.pack_nft_id = h.p->>'pack_nft_id' AND op.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
WHERE (p->>'moments_pulled')::int > 0;
REVOKE ALL ON flowty_archive.nft_pack_pull_prices_20261114 FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS flowty_archive.moment_acquisitions_bak_pack_pull_20261114 AS
SELECT m.* FROM moment_acquisitions m
JOIN flowty_archive.nft_pack_pull_prices_20261114 x ON x.nft_id = m.nft_id
WHERE m.wallet = '0xbd94cade097e50ac' AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND m.buy_price IS NULL;
REVOKE ALL ON flowty_archive.moment_acquisitions_bak_pack_pull_20261114 FROM PUBLIC, anon, authenticated;

UPDATE moment_acquisitions m SET
  buy_price = x.cost_per_pull,
  acquisition_method = 'pack_pull',
  pack_dist_id = COALESCE(m.pack_dist_id, x.dist_id),
  source = 'pack_history_price',
  acquisition_confidence = CASE WHEN x.buy_price_source = 'retail_inferred' THEN 'heuristic' ELSE 'verified' END
FROM flowty_archive.nft_pack_pull_prices_20261114 x, flowty_archive.moment_acquisitions_bak_pack_pull_20261114 b
WHERE b.id = m.id AND x.nft_id = m.nft_id AND m.buy_price IS NULL;

DO $$ DECLARE n int; s numeric; BEGIN
  SELECT count(*), sum(buy_price) INTO n, s FROM moment_acquisitions
  WHERE id IN (SELECT id FROM flowty_archive.moment_acquisitions_bak_pack_pull_20261114) AND source = 'pack_history_price';
  IF n <> 234 OR s <> 1735.07 THEN RAISE EXCEPTION 'nft pack pull cost: expected 234 / 1735.07, got % / %', n, s; END IF;
END $$;
