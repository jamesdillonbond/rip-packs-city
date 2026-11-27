-- Rip Packs City: contents of Top Shot AND All Day packs that left a saved wallet, revealed before
-- 2025-10-15. Written 2026-11-27 (Sold-tab backfill). NOT YET EXECUTED: the Dune team is out of credits
-- until 2026-12-14 and its extra-credits limit is 0; the team is also at its private-query cap, so this
-- lives here rather than as a saved Dune query.
--
-- WHY THIS SOURCE: no live Flow node serves blocks before 130290659 (mainnet26 and older; #181), and
-- Atlas, Top Shot's public GraphQL and the Find Labs historical API were all dead on 11-27.
-- Both PackNFT contracts emit Revealed(id, salt, nfts: String); `nfts` lists the pack's items, e.g.
-- "A.0b2a3299cc857e29.TopShot.<momentId>,..." (a box lists "...PackNFT.<packId>"); verified on a live
-- Top Shot event 2026-11-27. Mint events: TopShot.MomentMinted(momentID, playID, setID, serialNumber,
-- subeditionID); AllDay.MomentNFTMinted(id, editionID, serialNumber) (read from the deployed contracts).
--
-- PARAMETER {{wallets}}: comma-separated saved-wallet addresses WITHOUT 0x, built at run time from
--   SELECT string_agg(DISTINCT substr(wallet_addr, 3), ',') FROM public.saved_wallets
--    WHERE wallet_addr ~ '^0x[0-9a-f]{16}$';
-- Never save a wallet list as a Dune query's default value.
--
-- OUTPUT -> public.pack_reveal_import (collection = 'ts' -> 95f28a17-224a-4025-96ad-adf8a4c63bfd,
-- 'ad' -> dee28451-5d62-409e-a1ad-a83f763ac070; edition_key = All Day editionID; source = 'dune'),
-- then SELECT public.load_pack_reveal_import();
-- Expected size (11-27): ~18.5k Top Shot + ~3.4k All Day sold packs, plus the saved wallets' own opens.
WITH wallets AS (
  SELECT lower(trim(x)) AS a FROM UNNEST(split('{{wallets}}', ',')) AS t(x)
),
pack_contracts(coll, prefix) AS (
  VALUES ('ts', 'A.0b2a3299cc857e29'), ('ad', 'A.e4cf4bdc1751c65d')
),
left_wallet AS (
  SELECT DISTINCT c.coll, json_extract_scalar(e.data, '$.id') AS pack_id
  FROM flow.cadence_events e
  JOIN pack_contracts c ON e.topics[1] = c.prefix || '.PackNFT.Withdraw'
  WHERE e.block_date >= DATE '2021-06-01' AND e.block_date < DATE '2025-10-15'
    AND cardinality(e.topics) > 0
    AND lower(replace(json_extract_scalar(e.data, '$.from'), '0x', '')) IN (SELECT a FROM wallets)
),
revealed AS (
  SELECT c.coll, json_extract_scalar(e.data, '$.id') AS pack_id,
         json_extract_scalar(e.data, '$.nfts') AS nfts,
         lower(replace(e.transaction_hash, '0x', '')) AS reveal_tx,
         e.block_height AS reveal_block
  FROM flow.cadence_events e
  JOIN pack_contracts c ON e.topics[1] = c.prefix || '.PackNFT.Revealed'
  WHERE e.block_date >= DATE '2021-06-01' AND e.block_date < DATE '2025-10-15'
    AND cardinality(e.topics) > 0
    AND (c.coll, json_extract_scalar(e.data, '$.id')) IN (SELECT coll, pack_id FROM left_wallet)
),
items AS (
  SELECT r.coll, r.pack_id, r.reveal_tx, r.reveal_block,
         CASE WHEN strpos(t.tok, '.PackNFT.') > 0 THEN 'pack' ELSE 'moment' END AS item_kind,
         regexp_extract(trim(t.tok), '([0-9]+)$', 1) AS item_id
  FROM revealed r
  CROSS JOIN UNNEST(split(r.nfts, ',')) AS t(tok)
  WHERE regexp_like(trim(t.tok), '^A\.(0b2a3299cc857e29\.(TopShot|PackNFT)|e4cf4bdc1751c65d\.(AllDay|PackNFT))\.[0-9]+$')
),
ts_mint AS (
  SELECT json_extract_scalar(data, '$.momentID') AS moment_id,
         CAST(json_extract_scalar(data, '$.setID') AS integer) AS set_id,
         CAST(json_extract_scalar(data, '$.playID') AS integer) AS play_id,
         CAST(json_extract_scalar(data, '$.subeditionID') AS integer) AS subedition_id,
         CAST(json_extract_scalar(data, '$.serialNumber') AS integer) AS serial_number
  FROM flow.cadence_events
  WHERE block_date >= DATE '2020-10-01' AND block_date < DATE '2025-10-15'
    AND cardinality(topics) > 0
    AND topics[1] = 'A.0b2a3299cc857e29.TopShot.MomentMinted'
    AND json_extract_scalar(data, '$.momentID') IN (SELECT item_id FROM items WHERE coll = 'ts' AND item_kind = 'moment')
),
ad_mint AS (
  SELECT json_extract_scalar(data, '$.id') AS moment_id,
         json_extract_scalar(data, '$.editionID') AS edition_key,
         CAST(json_extract_scalar(data, '$.serialNumber') AS integer) AS serial_number
  FROM flow.cadence_events
  WHERE block_date >= DATE '2021-06-01' AND block_date < DATE '2025-10-15'
    AND cardinality(topics) > 0
    AND topics[1] = 'A.e4cf4bdc1751c65d.AllDay.MomentNFTMinted'
    AND json_extract_scalar(data, '$.id') IN (SELECT item_id FROM items WHERE coll = 'ad' AND item_kind = 'moment')
)
SELECT i.coll AS collection, i.pack_id AS pack_nft_id, i.item_kind, i.item_id, i.reveal_tx, i.reveal_block,
       tm.set_id, tm.play_id, tm.subedition_id, am.edition_key,
       COALESCE(tm.serial_number, am.serial_number) AS serial_number
FROM items i
LEFT JOIN ts_mint tm ON i.coll = 'ts' AND i.item_kind = 'moment' AND tm.moment_id = i.item_id
LEFT JOIN ad_mint am ON i.coll = 'ad' AND i.item_kind = 'moment' AND am.moment_id = i.item_id
