-- 2026-10-29 ~9:20 AM PT (Claude Code cloud). Ten Panini NFL products (2021 NFL Packs
-- Entertainment, 2021 NFL Donruss Optic / Prizm, 2021 Select Football, 2022 Donruss Optic /
-- Mosaic / Prizm Football, 2023 Flawless / Prizm Football, 2024 Obsidian Football) carried
-- panini_products.last_grid_sport = '?'. The residential runner tags a set sighted outside any
-- sport grid as "?" (`currentSport ?? "?"`) and /api/cron/panini-ingest stored it verbatim.
-- Every reader of last_grid_sport took it as a sport: /insights/panini-premiums showed a "?"
-- sport chip over 1,079 parallel + 21 serial rows, and the team-key functions (which keep only
-- Basketball / Baseball / Football / Womens Basketball) dropped these products' cards.
-- The route stops writing "?" in the same commit (an unknown sighting leaves the stored sport).
-- All ten names are unambiguous NFL / Football products; `sport` (the curated column) was NULL.
--
-- REVERT:
--   UPDATE public.panini_products SET last_grid_sport = '?'
--    WHERE set_id IN (1579, 1566, 1584, 1613, 1780, 1705, 1759, 2019, 1940, 2126);

UPDATE public.panini_products
   SET last_grid_sport = 'Football'
 WHERE set_id IN (1579, 1566, 1584, 1613, 1780, 1705, 1759, 2019, 1940, 2126)
   AND last_grid_sport = '?'
   AND (name ILIKE '%NFL%' OR name ILIKE '%Football%');

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM public.panini_products WHERE last_grid_sport = '?') THEN
    RAISE EXCEPTION 'a product still carries the "?" sport';
  END IF;
  IF (SELECT count(*) FROM public.panini_products WHERE set_id IN (1579, 1566, 1584, 1613, 1780, 1705, 1759, 2019, 1940, 2126) AND last_grid_sport = 'Football') <> 10 THEN
    RAISE EXCEPTION 'expected the 10 NFL products to read Football';
  END IF;
END
$mig$;
