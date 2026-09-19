-- WHY (measured live 2026-09-19 ~11:1x PT, Cowork cloud).
--
-- `/insights/panini-squeeze` has been public since 2026-08-01 and its headline is
-- `sealed_fmv_exposure_usd` = $2,552,633. Measured against `fmv_confidence` today:
--
--   ASK_ONLY   871 editions (17.2%)  $1,338,443  = 52.4% OF THE HEADLINE
--   HIGH     3,217 editions (63.5%)  $  892,765  = 35.0%
--   LOW        587                   $  207,068  =  8.1%
--   MEDIUM     393                   $  114,357  =  4.5%
--
-- ASK_ONLY means 0.90 x ONE seller's ask on a card with NO recorded sale. So the majority of the
-- number a visitor reads as market value is composed of prices nobody has ever paid. The board's
-- own top row is the shape in miniature: Ousmane Dembele, mint 12, FMV $900,000 from a $1,000,000
-- ask, ZERO sales, last walked 22 days ago -- against $59,276 for the most valuable edition in
-- the set that has ACTUALLY traded (Messi Base Prizms Gold, 8 recorded sales). Others: Messi 1/1
-- $450,009 from a $500,010 ask (0 sales, walked 61 days ago), Mbappe 1/1 $144,000 from $160,000.
-- The ask shapes themselves ($500,010, $84,999, $125,000) are the documented troll-listing tell.
--
-- ⛔ THIS MIGRATION CHANGES NO PRICE, AND THAT IS DELIBERATE. Re-pricing or clamping ASK_ONLY is
-- a real-money judgement and is Trevor's, not a night-pass call (the same boundary R105's FMV
-- question sits behind). What is NOT a judgement call is that the headline should say what it is
-- made of. The per-ROW basis is already disclosed ("from asks", lib/fmv-basis.ts); the AGGREGATE
-- had no such marker, and an aggregate is what a reader quotes.
--
-- Additive: the eight existing columns keep their names, types and order.
--
-- ⚠ Enum comparisons are written against `fmv_confidence` literals, not text. A first attempt
-- using ARRAY['HIGH'::text,...] failed with 42883 `operator does not exist: fmv_confidence = text`
-- -- the single-literal `= 'ASK_ONLY'` had worked only because Postgres infers the literal's type.
--
-- ⚠ security_invoker is RESTATED here on purpose -- CREATE OR REPLACE VIEW resets reloptions it
-- does not restate, which is exactly how three views silently became DEFINER earlier today
-- (migration 20260919173610). Verified after applying: check_public_security_invariants() = 0.
--
-- REVERT (exact): re-run this statement with the four `-- >>> ADDED` columns deleted, keeping
-- `with (security_invoker = true)`.
--
-- Not a function: no anon-exec marker applies.

create or replace view public.panini_squeeze_totals
with (security_invoker = true) as
 SELECT count(*) AS editions,
    round(COALESCE(sum(sealed_fmv_exposure_usd), 0::numeric)) AS sealed_fmv_exposure_usd,
    count(*) FILTER (WHERE mint_cap <= 25) AS chases_lte_25,
    COALESCE(sum(still_in_packs), 0::bigint) AS sealed_copies,
    count(*) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AS editions_hc,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])), 0::numeric)) AS sealed_fmv_exposure_usd_hc,
    COALESCE(sum(still_in_packs) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])), 0::bigint) AS sealed_copies_hc,
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['heavily_biased'::text, 'listing_gated'::text])), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd), 0::numeric), 1) AS pct_sealed_usd_from_biased_sets,
    -- >>> ADDED 2026-09-19: what the headline is MADE OF. ASK_ONLY = 0.90 x one seller's ask on
    -- a card with no recorded sale, so this is the share of the number that no trade supports.
    count(*) FILTER (WHERE fmv_confidence = 'ASK_ONLY'::fmv_confidence) AS editions_ask_only,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE fmv_confidence = 'ASK_ONLY'::fmv_confidence), 0::numeric)) AS sealed_fmv_exposure_usd_ask_only,
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE fmv_confidence = 'ASK_ONLY'::fmv_confidence), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd), 0::numeric), 1) AS pct_sealed_usd_from_asks_only,
    -- The counterweight, so the disclosure is a COMPOSITION and not just an alarm: the share a
    -- recorded sale actually stands behind.
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd), 0::numeric), 1) AS pct_sealed_usd_sale_backed
   FROM panini_squeeze_board
  WHERE fmv_usd IS NOT NULL;

comment on view public.panini_squeeze_totals is
  'Headline aggregates for /insights/panini-squeeze. ⚠ sealed_fmv_exposure_usd is NOT majority sale-backed: measured 2026-09-19, 52.4% of it came from 871 ASK_ONLY editions (0.90 x one ask, zero recorded sales) against 35.0% HIGH. Read pct_sealed_usd_from_asks_only / pct_sealed_usd_sale_backed beside it, and never publish the headline without one of them.';