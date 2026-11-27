-- Rip Packs City: contents of Top Shot packs that left a saved wallet, opened before 2025-10-14.
-- Written 2026-11-27 (Sold-tab backfill). NOT YET EXECUTED: the Dune team is out of credits until
-- 2026-12-14 and its extra-credits limit is 0; the team is also at its private-query cap, so this lives
-- here rather than as a saved Dune query.
--
-- WHY THIS SOURCE: no live Flow node serves blocks before 130290659 (mainnet26 and older; #181), and
-- Atlas, Top Shot's public GraphQL and the Find Labs historical API were all dead on 11-27.
-- PackNFT (A.0b2a3299cc857e29) emits Revealed(id, salt, nfts: String); `nfts` lists the pack's items as
-- "A.0b2a3299cc857e29.TopShot.<momentId>,..." (a box lists "A.0b2a3299cc857e29.PackNFT.<packId>"),
-- verified on a live event 2026-11-27.
--
-- PARAMETER {{wallets}}: comma-separated saved-wallet addresses WITHOUT 0x, built at run time from
--   SELECT string_agg(DISTINCT substr(wallet_addr, 3), ',') FROM public.saved_wallets
--    WHERE wallet_addr ~ '^0x[0-9a-f]{16}$';
-- Do not save a wallet list into a Dune query's default value.
--
-- OUTPUT -> public.topshot_pack_pull_import (pack_nft_id, item_kind, item_id, reveal_tx, reveal_block,
-- set_id, play_id, subedition_id, serial_number; source = 'dune'), then
-- SELECT public.load_topshot_pack_pull_import();
-- Expected size (11-27): ~18.5k sold packs opened before 10-14 + the saved wallets' own opens.
WITH wallets AS (
  SELECT lower(trim(x)) AS a FROM UNNEST(split('{{wallets}}', ',')) AS t(x)
),
left_wallet AS (
  SELECT DISTINCT json_extract_scalar(data, '$.id') AS pack_id
  FROM flow.cadence_events
  WHERE block_date >= DATE '2021-06-01' AND block_date < DATE '2025-10-15'
    AND cardinality(topics) > 0
    AND topics[1] = 'A.0b2a3299cc857e29.PackNFT.Withdraw'
    AND lower(replace(json_extract_scalar(data, '$.from'), '0x', '')) IN (SELECT a FROM wallets)
),
revealed AS (
  SELECT json_extract_scalar(e.data, '$.id') AS pack_id,
         json_extract_scalar(e.data, '$.nfts') AS nfts,
         lower(replace(e.transaction_hash, '0x', '')) AS reveal_tx,
         e.block_height AS reveal_block
  FROM flow.cadence_events e
  WHERE e.block_date >= DATE '2021-06-01' AND e.block_date < DATE '2025-10-15'
    AND cardinality(e.topics) > 0
    AND e.topics[1] = 'A.0b2a3299cc857e29.PackNFT.Revealed'
    AND json_extract_scalar(e.data, '$.id') IN (SELECT pack_id FROM left_wallet)
),
items AS (
  SELECT r.pack_id, r.reveal_tx, r.reveal_block,
         CASE WHEN strpos(t.tok, '.PackNFT.') > 0 THEN 'pack' ELSE 'moment' END AS item_kind,
         regexp_extract(trim(t.tok), '([0-9]+)$', 1) AS item_id
  FROM revealed r
  CROSS JOIN UNNEST(split(r.nfts, ',')) AS t(tok)
  WHERE regexp_like(trim(t.tok), '^A\.0b2a3299cc857e29\.(TopShot|PackNFT)\.[0-9]+$')
),
mint AS (
  SELECT json_extract_scalar(data, '$.momentID') AS moment_id,
         CAST(json_extract_scalar(data, '$.setID') AS integer) AS set_id,
         CAST(json_extract_scalar(data, '$.playID') AS integer) AS play_id,
         CAST(json_extract_scalar(data, '$.subeditionID') AS integer) AS subedition_id,
         CAST(json_extract_scalar(data, '$.serialNumber') AS integer) AS serial_number
  FROM flow.cadence_events
  WHERE block_date >= DATE '2020-10-01' AND block_date < DATE '2025-10-15'
    AND cardinality(topics) > 0
    AND topics[1] = 'A.0b2a3299cc857e29.TopShot.MomentMinted'
    AND json_extract_scalar(data, '$.momentID') IN (SELECT item_id FROM items WHERE item_kind = 'moment')
)
SELECT i.pack_id AS pack_nft_id, i.item_kind, i.item_id, i.reveal_tx, i.reveal_block,
       m.set_id, m.play_id, m.subedition_id, m.serial_number
FROM items i
LEFT JOIN mint m ON i.item_kind = 'moment' AND m.moment_id = i.item_id
