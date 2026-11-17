-- Golazos Series 2 (2023-24) and Series 3 (2024-25) never existed.
-- Measured on-chain 2026-08-23 against the Golazos contract at 0x87ca73a41bb50ad5
-- (Flow mainnet, /v1/scripts):
--   nextSeriesID  = 2   -> exactly ONE series was ever created ("Series 1", active)
--   nextEditionID = 576 -> 575 editions ever minted
--   totalSupply   = 1,919,761 moments
-- Corroborated by three independent instruments:
--   * laligagolazos.com (vendor's own front-end): /editions/575 -> 200, /editions/576+ -> 500;
--     marketplace facets top out at season 2022-2023.
--   * dapper.market/laliga/edition/600 -> "Edition not found" (541 resolves).
--   * our own editions table: 575 rows, ids 1..575, zero gaps, zero above 575.
-- These two rows only ever produced dead filters and two indexable, permanently
-- empty /laliga-golazos/series/series-{2,3} pages (JSON-LD numberOfItems: 0).
--
-- REVERT:
--   INSERT INTO collection_series (id, collection_id, series_number, display_label, season) VALUES
--     (29,'06248cc4-b85f-47cd-af67-1855d14acd75',2,'Series 2','2023-24'),
--     (30,'06248cc4-b85f-47cd-af67-1855d14acd75',3,'Series 3','2024-25');
DELETE FROM public.collection_series
WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
  AND series_number IN (2, 3);