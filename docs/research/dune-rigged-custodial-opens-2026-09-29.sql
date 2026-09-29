-- Rigged (0xf77bf547fccf6656): every Top Shot delivery from a Dapper pack-delivery
-- account, all time, one row per month x sender x "was it an NFT pack open".
-- Aggregated on purpose: ~60 rows x 5 cols, a few hundred datapoints. Budget has
-- 1,000,000 datapoints left this cycle. Credits: one all-time scan of the
-- TopShot Deposit/Withdraw topics, measured ~46 credits in July.
--
-- STEP 0 (method step 3, apis-and-cadence.md): read ONE Deposit and ONE Withdraw
-- payload first and fix the JSON paths below if they differ ($.to / $.from / $.id
-- may be nested under an Optional wrapper).
--
-- Validation arm: from 2023-11 on, nft_pack=false + sender 0xe1f2... should match
-- RPC's chain_arrival_probes (2,343 txs as of 2026-09-29 ~11:57 AM PT, still
-- growing). Months before 2023-11 are the part RPC cannot read at all. This query
-- also catches packs whose pulls he has since SOLD, which the RPC bisect cannot.

WITH ev AS (
  SELECT transaction_hash, block_time, element_at(topics, 1) AS topic, data
  FROM flow.cadence_events
  WHERE block_date >= DATE '2020-10-01'
    AND element_at(topics, 1) IN (
      'A.0b2a3299cc857e29.TopShot.Deposit',
      'A.0b2a3299cc857e29.TopShot.Withdraw',
      'A.0b2a3299cc857e29.PackNFT.Opened')
),
dep AS (
  SELECT transaction_hash, block_time, json_extract_scalar(data, '$.id') AS id
  FROM ev
  WHERE topic = 'A.0b2a3299cc857e29.TopShot.Deposit'
    AND lower(json_extract_scalar(data, '$.to')) = '0xf77bf547fccf6656'
),
wd AS (
  SELECT transaction_hash, lower(json_extract_scalar(data, '$.from')) AS sender,
         json_extract_scalar(data, '$.id') AS id
  FROM ev
  WHERE topic = 'A.0b2a3299cc857e29.TopShot.Withdraw'
),
opened AS (
  SELECT DISTINCT transaction_hash FROM ev WHERE topic = 'A.0b2a3299cc857e29.PackNFT.Opened'
),
per_tx AS (
  SELECT d.transaction_hash, min(d.block_time) AS bt, max(w.sender) AS sender,
         count(*) AS n_moments, bool_or(o.transaction_hash IS NOT NULL) AS nft_pack
  FROM dep d
  JOIN wd w ON w.transaction_hash = d.transaction_hash AND w.id = d.id
  LEFT JOIN opened o ON o.transaction_hash = d.transaction_hash
  GROUP BY 1
)
SELECT date_trunc('month', bt) AS month, sender, nft_pack,
       count(*) AS txs, sum(n_moments) AS moments
FROM per_tx
-- NO sender filter: Dapper's delivery account CHANGES over time (packs.md), and
-- the pre-2023-11 one is unknown. Senders with many multi-moment txs a month are
-- the candidates; one-off collector senders drop out by the HAVING. Still only
-- a few hundred rows.
GROUP BY 1, 2, 3
HAVING count(*) >= 5
ORDER BY 1, 4 DESC;
