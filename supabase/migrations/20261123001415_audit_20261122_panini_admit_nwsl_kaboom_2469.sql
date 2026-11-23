-- 2026-11-22 PT (NWSL thread). Admit Panini set 2469 to the card walk: the "Kaboom!" insert line of
-- the 2026 Prizm Black NWSL drop (#1065). Identified from a sale record in the laptop runner's
-- panini-capture.jsonl — product_name "2026 Panini NFT Prizm Black NWSL Soccer - Kaboom! #1 -
-- Trinity Rodman - [2/25]", url_key packcard-2469_553503_12791715_1__2_25 — and served on the
-- Womens Soccer grid in Trevor's Chrome beside 2478/2460. Same drop as 2478 (admitted 11:40 AM PT,
-- 20261122193815); one drop spans several set ids. Unnamed on purpose (never two rows with one name).
-- Revert: UPDATE public.panini_products SET walk_cards = false WHERE set_id = 2469;
INSERT INTO public.panini_products (set_id, walk_cards, walk_cards_since, last_grid_sport, note)
VALUES (2469, true, now(), 'Womens Soccer', 'Kaboom! insert line of 2026 Prizm Black NWSL (drop #1065). Admitted by hand 2026-11-22 with 2478/2460.')
ON CONFLICT (set_id) DO UPDATE
  SET walk_cards = true,
      walk_cards_since = coalesce(public.panini_products.walk_cards_since, now()),
      last_grid_sport = coalesce(public.panini_products.last_grid_sport, EXCLUDED.last_grid_sport),
      note = coalesce(public.panini_products.note || ' | ', '') || EXCLUDED.note;
