-- audit_20261123_panini_one_of_ones_last_seen_at_sale
--
-- Follow-up to 20261123164815: sync_panini_products_bridge only bridges a panini_editions row with
-- last_seen_at within 45 days (a NULL never bridges), so the two catalogued 1/1s did not reach
-- `editions` on the 8:54 AM PT pass. Their last sighting is the SALE itself (panini_sales, Panini's
-- own sales feed) — set last_seen_at to that sold_at, not to now(): the listing walk has still never
-- seen them, and this ages out in 45 days like any other row unless the walk does.
--
-- Revert: UPDATE public.panini_editions SET last_seen_at = NULL WHERE id IN
--   ('packcard-1605_293026_7958740_56__1_1','packcard-2478_555348_13056695_55__1_1');

UPDATE public.panini_editions pe
   SET last_seen_at = s.sold_at, updated_at = now()
  FROM (SELECT edition_external_id, max(sold_at) AS sold_at FROM public.panini_sales
         WHERE edition_external_id IN ('packcard-1605_293026_7958740_56','packcard-2478_555348_13056695_55')
         GROUP BY edition_external_id) s
 WHERE pe.external_id = s.edition_external_id
   AND pe.id IN ('packcard-1605_293026_7958740_56__1_1','packcard-2478_555348_13056695_55__1_1')
   AND pe.last_seen_at IS NULL;
