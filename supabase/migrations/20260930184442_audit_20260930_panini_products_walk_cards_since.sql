-- audit_20260930_panini_products_walk_cards_since
--
-- When a Panini product was ADMITTED (walk_cards switched on). The ingest route's walk-order GET
-- uses it to bound its bootstrap mode: a just-admitted product with no catalogue rows gets one
-- narrowed walk, but only within PANINI_BOOTSTRAP_HOURS of admission, so a product whose cards
-- cannot be walked never starves the rest of the walk. Stamped by trigger on every false->true
-- flip (and on insert with walk_cards=true), so no caller has to remember it.
-- 2420 (2026 Panini NFT Prizm WNBA) was admitted 2026-09-30 ~8:30 AM PT (15:32 UTC) by hand.
--
-- REVERT: DROP TRIGGER trg_panini_products_walk_cards_since ON public.panini_products;
--         DROP FUNCTION public.panini_products_stamp_walk_cards_since();
--         ALTER TABLE public.panini_products DROP COLUMN walk_cards_since;
--         (the route treats a missing stamp as "no bootstrap".)

ALTER TABLE public.panini_products ADD COLUMN IF NOT EXISTS walk_cards_since timestamptz;

CREATE OR REPLACE FUNCTION public.panini_products_stamp_walk_cards_since()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.walk_cards AND (TG_OP = 'INSERT' OR NOT COALESCE(OLD.walk_cards, false)) THEN
    NEW.walk_cards_since := now();
  ELSIF NOT NEW.walk_cards THEN
    NEW.walk_cards_since := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_panini_products_walk_cards_since ON public.panini_products;
CREATE TRIGGER trg_panini_products_walk_cards_since
  BEFORE INSERT OR UPDATE OF walk_cards ON public.panini_products
  FOR EACH ROW EXECUTE FUNCTION public.panini_products_stamp_walk_cards_since();

UPDATE public.panini_products SET walk_cards_since = '2026-09-30 15:32:00+00'
 WHERE set_id = 2420 AND walk_cards AND walk_cards_since IS NULL;

-- anon-exec decision: REVOKED. A trigger function is only ever run by its trigger (EXECUTE is
-- checked at CREATE TRIGGER, not at fire time), so no role needs to call it.
REVOKE EXECUTE ON FUNCTION public.panini_products_stamp_walk_cards_since() FROM PUBLIC, anon, authenticated;
