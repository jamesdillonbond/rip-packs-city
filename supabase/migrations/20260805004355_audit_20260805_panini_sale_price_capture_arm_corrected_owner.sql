-- 2026-08-05 · CORRECTION. The Panini sale-price loss is OURS, not upstream's.
-- Renames panini_upstream_sale_price_dry_days -> panini_sale_price_capture_dry_days
-- and rewrites the catches text, because the old name and text both asserted a
-- supplier outage and would have sent someone to chase Panini for a defect we own.
--
-- ⚠⚠ READ THIS FIRST — THIS MIGRATION'S NARRATIVE WAS ITSELF DISPROVEN HOURS LATER.
-- Recovered into the repo 2026-08-04 PT by Claude Code, which then tested the story
-- below against the on-disk ops capture and the DB and found the MECHANISM wrong.
-- See docs/panini-capture-root-cause-CORRECTION-2026-08-04.md. In short:
--   · getCardMarketStats fires on EVERY detail page (2,412 times, HTTP 200, across
--     all 5 captured runs) and IS intercepted -- it is not missing.
--   · cards DO land: panini_editions.updated_at tracks the last capture to the
--     second, 557 editions updated in 6h, player_name/for_sale_count 0% null.
--   · price_usd is NOT being lost. Priced serials/day ran 514-1,366 before and
--     613-2,038 after; the null RATE rose only because captured volume tripled
--     (1,315 -> 8,865/day) once the 07-26 DOM harvest stopped being listing-gated.
--     Pre-07-27 read 0.0% null precisely BECAUSE it only ever saw listed cards.
--   · The one genuine defect is last_sale_usd: ~494/day -> 0 -> ~80-200 while
--     volume rose 6x. Absolute count collapsed; that one is real and still open.
-- The RENAME and the breach_at are still right. The catches TEXT is not, and is
-- left in place only so the repo matches prod; correcting it is a separate change.
--
-- WHAT THE 08-05 EVIDENCE WAS TAKEN TO SHOW (retained verbatim for the record):
--
-- The raw payload envelope is UNCHANGED: 45 keys on every row, both before and
-- after. brought_at_price is PRESENT on all 16,200 rows captured 08-04 -- its VALUE
-- is JSON null. Values by day:
--     07-26  1,323 rows:      0 null · 829 "0" · 494 real
--     07-27  2,563 rows:  1,697 null · 530 "0" · 336 real
--     07-28  4,337 rows:  4,252 null ·  39 "0" ·  46 real
--     07-29  4,946 rows:  4,946 null ·   0 "0" ·   0 real
--     08-04 16,200 rows: 16,200 null ·   0 "0" ·   0 real
-- The "0" sentinel vanished too. A supplier that stops pricing still answers "0"
-- for an unsold serial; ours stopped answering at all, including the negative case.
--
-- AND IT IS NOT ONE FIELD. Comparing populated-key sets 07-26 vs 08-04, sixteen
-- fields went fully-populated -> 100% null together: athlete, auto_accept,
-- brought_at_price, brought_at_time, burnable_count, burned_count, burnt_percent,
-- cardset, collection, genesis_year, image_url, inventory_count, pan_video_link,
-- rarity, sport_name, year. Meanwhile TWO fields went 100% null -> 100% populated:
-- token_id and my_public_wallet.
--
-- That is a DIFFERENT ENDPOINT, not a degraded one. We moved from a card/catalog
-- detail source (athlete, cardset, rarity, images, sale history) to a
-- wallet/inventory source (token_id, my_public_wallet), sharing one 45-key DTO.
-- The ~07-27 volume jump (1.3k -> 16.2k serials/day) is the same change: an
-- inventory sweep enumerates far more rows than a per-card detail fetch.
--
-- BLAST RADIUS IS WIDER THAN SALE PRICE. Column null rates, serials captured
-- before vs after the switch:
--     price_usd       30.9% -> 77.4% null      <-- ASK prices, not just sales
--     last_sale_usd   76.7% -> 99.1% null
--     best_offer_usd  12.8% -> 17.1% null
-- panini_preserve_sale_fields covers ONLY last_sale_usd/last_sale_at, so nothing
-- protects price_usd. This also contaminates the 34.5%-have-an-ask figure behind
-- the 2026-08-04 panini_special_serials_board.is_listed fix: that fix is still
-- strictly more honest than publishing a constant true, but its denominator is
-- depressed by this defect and must be re-derived after the ingest is repaired.
--
-- ⚠ THE METHOD ERROR WORTH KEEPING: panini_card_serials.raw is OUR OWN STORED COPY.
-- It is an instrument we control, not the supplier's testimony. "The field is empty
-- in raw" cannot distinguish "they stopped sending it" from "we stopped asking for
-- it" -- and the 2026-08-04 finding asserted the first without testing the second.
-- The discriminator is the POPULATED-KEY SET, not any single field.
--
-- breach_at stays 3. The measurement is still correct and still the right alarm;
-- only the attribution changes. Value reads 7 and continues to breach.
--
-- REVERT: rename back and restore the prior catches literal.
-- ⚠ CREATE OR REPLACE VIEW drops reloptions; security_invoker=on is re-set below.

DO $mig$
DECLARE
  v_fn  text;
  v_def text;
  v_new text;
  c_old text;
  c_new text;
BEGIN
  ------------------------------------------------------------------
  -- 1. precompute: rename the metric key it writes
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'rpc_trust_health_precompute_refresh';

  IF position('panini_upstream_sale_price_dry_days' in v_fn) = 0 THEN
    RAISE EXCEPTION 'precompute does not write panini_upstream_sale_price_dry_days';
  END IF;

  EXECUTE replace(v_fn, 'panini_upstream_sale_price_dry_days',
                        'panini_sale_price_capture_dry_days');

  ------------------------------------------------------------------
  -- 2. carry the current value across, drop the old row
  ------------------------------------------------------------------
  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  SELECT 'panini_sale_price_capture_dry_days', value, computed_at, duration_ms
  FROM public.rpc_trust_health_precompute
  WHERE metric = 'panini_upstream_sale_price_dry_days'
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  DELETE FROM public.rpc_trust_health_precompute
  WHERE metric = 'panini_upstream_sale_price_dry_days';

  ------------------------------------------------------------------
  -- 3. the arm: new name, corrected story
  ------------------------------------------------------------------
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  c_old := 'UPSTREAM stopped sending Panini sale prices altogether. Counts the consecutive most-recent CAPTURE DAYS on which v_panini_serial_sale_field_supply saw raw_supplied_sale_price = 0. NOT the same thing as panini_sale_field_mapping_shortfall, which reads 0 and watches whether OUR ingest drops a price upstream DID send: that one is a defect we own and can fix, this one is a supply outage with a different owner entirely, and until 2026-08-04 NOTHING watched it.';

  c_new := 'OUR PANINI INGEST STOPPED CAPTURING SALE PRICES -- corrected 2026-08-05, this arm previously blamed upstream and was WRONG. Counts the consecutive most-recent CAPTURE DAYS on which v_panini_serial_sale_field_supply saw raw_supplied_sale_price = 0. WHAT ACTUALLY HAPPENED: the raw envelope is unchanged at 45 keys and brought_at_price is PRESENT on all 16,200 rows captured 08-04 -- its VALUE is JSON null. By day: 07-26 zero nulls (829 zero-sentinel, 494 real), 07-27 1,697 null, 07-28 4,252 null, 07-29 onward 100% null. The zero SENTINEL vanished with the real values, and a supplier that stops pricing still answers 0 for an unsold serial. Comparing populated-key sets 07-26 vs 08-04, SIXTEEN fields flipped fully-populated to 100% null together (athlete, cardset, rarity, sport_name, year, image_url, inventory_count, burned_count, burnt_percent, burnable_count, collection, genesis_year, pan_video_link, auto_accept, brought_at_price, brought_at_time) while token_id and my_public_wallet flipped 100% null to 100% populated. That is a DIFFERENT ENDPOINT -- a wallet/inventory source replacing a card/catalog detail source, sharing one DTO -- and the simultaneous volume jump from 1.3k to 16.2k serials a day is the same change. BLAST RADIUS IS WIDER THAN SALE PRICE: comparing serials captured before vs after the switch, price_usd null went 30.9% to 77.4% and last_sale_usd 76.7% to 99.1%, so ASK prices are being lost too, and panini_preserve_sale_fields protects only last_sale_usd/last_sale_at. FIX IS OURS: restore the catalog-detail fetch, or hydrate the missing fields from it, before any Panini launch gate is set. NOT the same arm as panini_sale_field_mapping_shortfall, which reads 0 and asks a narrower question -- whether we drop a price that DID arrive in raw. Both are ours; this one fires when the field never arrives.';

  IF position(c_old in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found: upstream catches preamble';
  END IF;

  v_new := replace(v_def, c_old, c_new);
  v_new := replace(v_new, 'panini_upstream_sale_price_dry_days',
                          'panini_sale_price_capture_dry_days');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'no change produced -- refusing to replace the view';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;
