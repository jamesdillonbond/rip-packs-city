-- UFC series derivation from edition external_id.
--
-- Before: 147 UFC editions, all with NULL series. /ufc-strike/series/* renders empty grids.
-- After:  0 NULL series. Mapping rule:
--   1) Date-bearing pattern  [A-Z]{3,5}-\d{1,2}-(\d{4})-      → year >= 2023 → series 2, else series 1
--   2) Fight-numbered pattern UFC-(\d{2,3})-                  → UFC >= 283 (Jan 2023) → series 2, else series 1
--   3) Fallback                                               → series 1 (S1 covers the broader 2022 era)
--
-- collection_series for UFC: id 31 (S0 / 2022), 32 (S1 / 2022), 33 (S2 / 2023-2025).
-- Series 0 is unused on the moment side — we map all 2022 fights to series 1.

WITH classified AS (
  SELECT
    id,
    (regexp_match(external_id, '[A-Z]{3,5}-\d{1,2}-(\d{4})-'))[1]::int AS year_int,
    (regexp_match(external_id, 'UFC-(\d{2,3})-'))[1]::int              AS ufc_num
  FROM editions
  WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
)
UPDATE editions e
SET series = CASE
  WHEN c.year_int IS NOT NULL AND c.year_int >= 2023 THEN 2
  WHEN c.year_int IS NOT NULL AND c.year_int <  2023 THEN 1
  WHEN c.ufc_num  IS NOT NULL AND c.ufc_num  >= 283  THEN 2
  ELSE 1
END,
last_updated_at = now()
FROM classified c
WHERE e.id = c.id
  AND e.series IS DISTINCT FROM (
    CASE
      WHEN c.year_int IS NOT NULL AND c.year_int >= 2023 THEN 2
      WHEN c.year_int IS NOT NULL AND c.year_int <  2023 THEN 1
      WHEN c.ufc_num  IS NOT NULL AND c.ufc_num  >= 283  THEN 2
      ELSE 1
    END
  );
