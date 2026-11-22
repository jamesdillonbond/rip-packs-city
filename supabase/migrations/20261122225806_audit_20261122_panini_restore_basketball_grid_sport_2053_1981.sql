-- 2026-11-22 PT (NWSL thread). The 2 PM PT residential run's "Womens Soccer" grid pass was served
-- Basketball/WNBA cards (not NWSL), and its sightings relabelled two NBA products last_grid_sport =
-- 'Womens Soccer' (2053 "2023-24 Panini NFT Best of The NBA", 1981 "2023-24 Panini NFT Prizm
-- Basketball"; samples: Luka Doncic / LeBron James). That label feeds refresh_panini_edition_team_keys
-- (which resolves teams per sport) and the franchise-hub sport wording. Restore 'Basketball'. The
-- runner now credits a grid sighting to the sport the REQUEST applied (scripts/panini-grid-sport.mjs).
-- Revert: UPDATE public.panini_products SET last_grid_sport = 'Womens Soccer' WHERE set_id IN (2053, 1981);
UPDATE public.panini_products
   SET last_grid_sport = 'Basketball'
 WHERE set_id IN (2053, 1981) AND last_grid_sport = 'Womens Soccer';
