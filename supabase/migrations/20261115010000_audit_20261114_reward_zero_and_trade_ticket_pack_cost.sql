-- 2026-11-14 (~5:00 PM PT, Cowork cloud). Trevor's rules (4:34 PM PT): "Challenge and Fastbreak reward packs should
-- remain at $0 cost. Trade ticket packs should value 'Trade Tickets' at whatever the lowest price Top Shot moment is
-- listed at."
--
-- Scope: wallet 0xbd94cade097e50ac, Top Shot, rows with buy_price NULL only.
--  (1) challenge_reward acquisitions -> buy_price 0.
--  (2) pulls of PackNFT rips whose pack has no dollar price and whose distribution is a reward (Fast Break, Quest
--      Reward, Challenge Reward, Leaderboard / Snapshot / Favorite Team Snap, Set Completion, Chaser, "Reward Pack")
--      -> buy_price 0, method pack_pull. Pulls with no acquisition row get one.
--  (3) pulls of Trade Ticket packs -> (tickets per pack x lowest listed Top Shot moment) / moments pulled. The ticket
--      count is the drop's pack_distributions.metadata.retail_price_usd (10 or 12 — Top Shot prices these packs in
--      tickets). Lowest listed Top Shot moment at 4:55 PM PT: $0.15 (ts_listings, 2 listings; 297 at $0.17). That is a
--      snapshot, recorded in flowty_archive.pack_pull_reward_ticket_cost_20261114.ticket_usd.
-- Not touched: Team packs (Celtics / Nuggets / Lakers / 76ers) and "2025 NBA Finals: Legendary Hit" (no price we hold),
-- and the 2,922 custodial (non-NFT) rips, whose drop we cannot name.
-- Backup: flowty_archive.moment_acquisitions_bak_reward_ticket_20261114 (rows updated); inserted rows carry
-- transaction_hash 'pack_pull:' || pack_nft_id || ':' || nft_id.
-- Revert:
--   UPDATE moment_acquisitions m SET buy_price=b.buy_price, acquisition_method=b.acquisition_method, pack_dist_id=b.pack_dist_id,
--     source=b.source, acquisition_confidence=b.acquisition_confidence
--   FROM flowty_archive.moment_acquisitions_bak_reward_ticket_20261114 b WHERE m.id=b.id;
--   DELETE FROM moment_acquisitions WHERE wallet='0xbd94cade097e50ac' AND source IN ('reward_pack_zero','trade_ticket_pack')
--     AND transaction_hash LIKE 'pack_pull:%';

CREATE TABLE IF NOT EXISTS flowty_archive.pack_pull_reward_ticket_cost_20261114 AS
WITH pk AS (
  SELECT p->>'pack_nft_id' AS pack_nft_id, p->>'dist_id' AS dist_id, (p->>'moments_pulled')::int AS moments_pulled,
         pd.title, pd.metadata->>'retail_price_usd' AS retail_raw
  FROM generate_series(0, 3200, 200) o,
       jsonb_array_elements(public.get_wallet_pack_history('0xbd94cade097e50ac','nba_top_shot','ripped',200,o)->'packs') p
  LEFT JOIN pack_distributions pd ON pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pd.dist_id = p->>'dist_id'
  WHERE p->>'rip_source' = 'rip' AND COALESCE((p->>'buy_usd')::numeric, 0) = 0
),
c AS (
  SELECT pk.*,
    CASE WHEN title ILIKE '%trade ticket%' THEN 'ticket'
         WHEN title ~* '(fast break|quest reward|challenge reward|leaderboard|snapshot|favorite team snap|set completion reward|chaser reward|reward pack)' THEN 'reward'
    END AS kind
  FROM pk
)
SELECT c.pack_nft_id, c.dist_id, c.title, c.kind, c.moments_pulled, op.nft_id,
       CASE WHEN c.kind = 'ticket' THEN c.retail_raw::numeric END AS tickets,
       0.15::numeric AS ticket_usd,
       CASE WHEN c.kind = 'reward' THEN 0::numeric
            ELSE round(c.retail_raw::numeric * 0.15 / NULLIF(c.moments_pulled, 0), 2) END AS cost_per_pull
FROM c JOIN pack_open_pulls op ON op.pack_nft_id = c.pack_nft_id AND op.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
WHERE c.kind IS NOT NULL;
REVOKE ALL ON flowty_archive.pack_pull_reward_ticket_cost_20261114 FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS flowty_archive.moment_acquisitions_bak_reward_ticket_20261114 AS
SELECT m.* FROM moment_acquisitions m
WHERE m.wallet = '0xbd94cade097e50ac' AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND m.buy_price IS NULL
  AND (m.acquisition_method = 'challenge_reward'
       OR m.nft_id IN (SELECT nft_id FROM flowty_archive.pack_pull_reward_ticket_cost_20261114));
REVOKE ALL ON flowty_archive.moment_acquisitions_bak_reward_ticket_20261114 FROM PUBLIC, anon, authenticated;

-- (1) challenge rewards
UPDATE moment_acquisitions m SET buy_price = 0, acquisition_confidence = 'verified'
FROM flowty_archive.moment_acquisitions_bak_reward_ticket_20261114 b
WHERE b.id = m.id AND m.buy_price IS NULL AND m.acquisition_method = 'challenge_reward'
  AND m.nft_id NOT IN (SELECT nft_id FROM flowty_archive.pack_pull_reward_ticket_cost_20261114);

-- (2)+(3) reward / ticket pack pulls with a row
UPDATE moment_acquisitions m SET
  buy_price = x.cost_per_pull,
  acquisition_method = 'pack_pull',
  pack_dist_id = COALESCE(m.pack_dist_id, x.dist_id),
  source = CASE WHEN x.kind = 'reward' THEN 'reward_pack_zero' ELSE 'trade_ticket_pack' END,
  acquisition_confidence = CASE WHEN x.kind = 'reward' THEN 'verified' ELSE 'heuristic' END
FROM flowty_archive.pack_pull_reward_ticket_cost_20261114 x, flowty_archive.moment_acquisitions_bak_reward_ticket_20261114 b
WHERE b.id = m.id AND x.nft_id = m.nft_id AND m.buy_price IS NULL AND x.cost_per_pull IS NOT NULL;

-- (2)+(3) pulls with no row at all
INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, transaction_hash, source, collection_id, acquisition_method,
                                 acquisition_confidence, pack_dist_id)
SELECT x.nft_id, '0xbd94cade097e50ac', x.cost_per_pull, 'pack_pull:' || x.pack_nft_id || ':' || x.nft_id,
       CASE WHEN x.kind = 'reward' THEN 'reward_pack_zero' ELSE 'trade_ticket_pack' END,
       '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'pack_pull',
       CASE WHEN x.kind = 'reward' THEN 'verified' ELSE 'heuristic' END, x.dist_id
FROM flowty_archive.pack_pull_reward_ticket_cost_20261114 x
WHERE x.cost_per_pull IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM moment_acquisitions m WHERE m.nft_id = x.nft_id AND m.wallet = '0xbd94cade097e50ac'
                  AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
ON CONFLICT DO NOTHING;
