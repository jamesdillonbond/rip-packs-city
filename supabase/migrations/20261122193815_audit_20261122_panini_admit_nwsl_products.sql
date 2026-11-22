-- 2026-11-22 PT (Trevor: "Both" — fix the NWSL ingest). Admit the two Panini products served ONLY by the
-- marketplace's "Womens Soccer" grid, which the discovery walk never visited until 145d2c5 (same day):
--   2478 — 2026 Prizm Black NWSL (drop #1065, Nov 20; e.g. packcard-2478_… Trinity Rodman 25/25)
--   2460 — a second NWSL product on the same grid (e.g. packcard-2460_… Sophia Wilson 1/25)
-- Set ids read from card links on ?sport=Womens%20Soccer in Trevor's Chrome, 11-22 ~11:45 AM PT.
-- Pre-admitting (not waiting for discovery to insert the row) puts "Womens Soccer" in the next run's
-- full_enum_sports and triggers the BOOTSTRAP narrowing (zero catalogue rows) so the first run walks
-- these cards. Discovery's own upsert never touches walk_cards/name/note on an existing row.
-- Revert: UPDATE public.panini_products SET walk_cards = false WHERE set_id IN (2460, 2478);
INSERT INTO public.panini_products (set_id, walk_cards, walk_cards_since, last_grid_sport, note)
VALUES
  (2478, true, now(), 'Womens Soccer', '2026 Prizm Black NWSL (drop #1065). Admitted by hand 2026-11-22: Womens Soccer grid was never walked before 145d2c5.'),
  (2460, true, now(), 'Womens Soccer', 'NWSL product on the Womens Soccer grid. Admitted by hand 2026-11-22 with 2478.')
ON CONFLICT (set_id) DO UPDATE
  SET walk_cards = true,
      walk_cards_since = coalesce(public.panini_products.walk_cards_since, now()),
      last_grid_sport = coalesce(public.panini_products.last_grid_sport, EXCLUDED.last_grid_sport),
      note = coalesce(public.panini_products.note || ' | ', '') || EXCLUDED.note;
