-- audit_20261027: NFL All Day Series 5 is the 2023 season, not 2022 (found during All Day ↔ Top Shot parity pass 9).
--
-- collection_series carried All Day as 1:2021 2:2021 3:2022 4:2022 5:2022 6:2023 7:2024 8:2024 9:2025 10:2025 — every
-- season a pair (a season series + its historical series) except 5. The data says 5 is the 2023 season: its sets include
-- "2023 Rookies", and of its 877 dated editions the games run 2023-01 → 2024-02 (14 fall in the 2022 season by the
-- Aug-start rule, the rest in 2023). /nfl-all-day/series/series-5 printed "2022" above plays dated Sep 10, 2023
-- (read live 10-27 ~6:50 PM PT). get_series_detail reads the season live, so the page corrects on its next render.
-- One row; guarded on the old value so a re-run is a no-op.
--
-- Revert: UPDATE public.collection_series SET season = '2022'
--          WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND series_number = 5;
UPDATE public.collection_series
   SET season = '2023'
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
   AND series_number = 5
   AND season = '2022';
