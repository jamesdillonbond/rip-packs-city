-- 2026-08-05 · Third and FINAL rewrite of this arm's catches text.
--
-- The first two versions each installed a confident mechanism. Both were wrong:
--   v1 (08-04) blamed UPSTREAM. Disproved: raw is our own stored copy, so an empty
--       field cannot distinguish "they stopped sending" from "we stopped asking".
--   v2 (08-05) blamed the walk abandoning pages before getCardMarketStats fired,
--       citing 0 occurrences in 2,748 ops. That measurement came from
--       panini-ops-capture.jsonl ALONE -- the freshly ROTATED tail -- while
--       panini-ops-capture.jsonl.1 (26 MB) held the rest of the same period. Against
--       the full 32,615-op capture on the runner box, getCardMarketStats fires 2,412
--       times, HTTP 200, on 787 of 795 detail pages. The v2 mechanism does not exist.
--
-- This version deliberately installs NO mechanism. It states what is measured, what is
-- ruled out, and what is unknown -- because two confident stories have already been
-- shipped and retracted here inside 24 hours.
--
-- ALSO WITHDRAWN: v2's claim that price_usd and best_offer_usd are being lost, and the
-- consequent claim that this contaminates the 08-04 is_listed fix. Absolute counts
-- ROSE (514-1,366 -> 613-2,038/day); only the denominator tripled when the 07-26 DOM
-- harvest ended listing-gating. That rate rise is the coverage fix working.
--
-- breach_at unchanged at 3. The defect it fires on -- last_sale_usd collapsing -- is
-- real, and was proved by controlling for parallel family.
--
-- ⚠ CREATE OR REPLACE VIEW drops reloptions; security_invoker=on is re-set below.

DO $mig$
DECLARE
  v_def text; v_new text; c_old text; c_new text;
  p_start int; p_end int;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  p_start := position('PANINI INGEST STOPPED CAPTURING SALE PRICES' in v_def);
  IF p_start = 0 THEN RAISE EXCEPTION 'anchor not found: v2 catches preamble'; END IF;

  -- back up to the opening quote of the literal
  p_start := p_start - 4;                       -- "OUR " precedes the anchor
  p_end := position('''::text AS text' in substring(v_def from p_start));
  IF p_end = 0 THEN RAISE EXCEPTION 'could not find literal terminator'; END IF;

  c_old := substring(v_def from p_start for p_end - 1);
  IF length(c_old) < 1000 THEN
    RAISE EXCEPTION 'isolated literal implausibly short: % chars', length(c_old);
  END IF;

  c_new := 'PANINI last_sale_usd CAPTURE HAS COLLAPSED -- real defect, MECHANISM NOT YET ESTABLISHED. Counts the consecutive most-recent CAPTURE DAYS on which v_panini_serial_sale_field_supply saw raw_supplied_sale_price = 0; 7+ and counting since 2026-07-29. WHAT IS MEASURED: brought_at_price is PRESENT as a key on 100% of captured rows and its VALUE is JSON null; by day, 07-26 had zero nulls (829 zero-sentinel, 494 real), 07-27 1,697 null, 07-28 4,252 null, 07-29 onward 100% null. Controlling for parallel family -- because a composition shift was the obvious alternative and had to be killed -- every family present in BOTH eras collapsed about 30x (family 486967: 45.8% to 1.7%), so this is not coverage rotation. WHAT IS RULED OUT, each having been asserted in an earlier version of this very text and then disproved: (a) an UPSTREAM outage -- panini_card_serials.raw is OUR OWN stored copy, an instrument we control, so an empty field cannot distinguish they-stopped-sending from we-stopped-asking; (b) the walk abandoning detail pages before getCardMarketStats fires -- against the FULL 32,615-op capture on the runner box that op fires 2,412 times, HTTP 200, on 787 of 795 pages, and the 0-occurrence reading came from parsing only the freshly rotated tail while the 26 MB .1 file held the rest of the same period; (c) price_usd and best_offer_usd being lost -- their absolute counts ROSE (514-1,366 to 613-2,038 per day) and only the DENOMINATOR tripled when the 2026-07-26 DOM harvest ended listing-gating, so that null-rate rise is the coverage fix working, not damage. Note item_counts = 0 in the ops capture is a NULL INSTRUMENT: findItems counts only o.items, so neither op can ever report non-zero -- never read it as an empty response. WHAT IS UNKNOWN: the mechanism. The leading reading is an all_cards bulk variant returning a lighter per-serial shape, which fits every observation, but BOTH capture generations post-date the 07-27 switch, so there is no pre-switch payload on disk to diff. Settling it needs a live A/B across listType values on the residential runner box -- interactive work, not a code read. DO NOT install another mechanism in this text without that A/B: a monitor that asserts a wrong cause is worse than one that asserts none. PRECOMPUTED at zero added cost in the same pass over v_panini_serial_sale_field_supply that panini_sale_field_mapping_shortfall already pays for; a missing or >24h-old precompute row reports 999 and BREACHES.';

  v_new := replace(v_def, c_old, c_new);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'no change produced -- refusing to replace the view';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;
