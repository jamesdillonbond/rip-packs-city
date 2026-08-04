-- 2026-08-04 · panini_special_serials_board.is_listed was publishing a constant.
--
-- MEASURED TODAY: panini_card_serials.is_listed is `true` on ALL 59,425 rows -- zero
-- false, zero NULL -- while only 20,471 (34.5%) carry a positive ask. The column
-- therefore carries no information and cannot be used as a predicate. Same class as
-- is_serialized on Pinnacle.
--
-- Two consumers, only one of them unsafe:
--   panini_deal_board            -- WHERE s.is_listed AND s.price_usd > 0. The
--                                   is_listed term is a no-op next to price_usd > 0.
--                                   SAFE, left alone.
--   panini_special_serials_board -- SELECTS s.is_listed AS AN OUTPUT COLUMN. On the
--                                   6,525 rows this board returns, 4,049 (62.1%) have
--                                   no ask at all, so a majority of the board would
--                                   publish "listed = true" for a card nobody has
--                                   listed a price for.
--
-- Latent today (this board grants SELECT to postgres + service_role only, no anon).
-- It becomes a LIVE FALSE CLAIM the moment PANINI_PUBLIC is wired, which is why this
-- belongs in the pre-flip checklist rather than after it.
--
-- FIX: the output column keeps the name is_listed (so no consumer signature changes,
-- and CREATE OR REPLACE VIEW can be used -- Postgres forbids renaming a view column)
-- but is now DERIVED from the only listing evidence that actually exists: a positive
-- ask. This follows the repo precedent of making a column say what it measures
-- (real_sales -> serials_with_recorded_price, 2026-07-31).
--
-- The upstream panini_card_serials.is_listed column is NOT touched -- the ingest writer
-- is out of scope from here -- but it now carries a COMMENT warning the next reader.
--
-- REVERT: replace the CASE below with `s.is_listed` and re-set security_invoker.
--
-- ⚠ CREATE OR REPLACE VIEW drops reloptions; security_invoker=on is re-set below.

CREATE OR REPLACE VIEW public.panini_special_serials_board AS
 SELECT s.sku,
    s.edition_external_id,
    s.serial_number,
    s.mint_cap,
    s.is_number_one,
    s.is_jersey_mint,
    s.is_perfect_mint,
        CASE
            WHEN s.is_number_one THEN 'number 1'::text
            WHEN s.is_perfect_mint THEN 'perfect mint'::text
            WHEN s.is_jersey_mint THEN 'jersey mint'::text
            ELSE NULL::text
        END AS headline_flag,
    s.nft_type AS all_flags,
    s.price_usd AS serial_ask_usd,
    s.best_offer_usd,
    s.last_sale_usd,
    s.last_sale_at,
    (COALESCE(s.price_usd, 0::numeric) > 0::numeric) AS is_listed,
    s.owner,
    e.player_name,
    e.nation,
    e.set_name AS parallel,
    e.tier,
    f.fmv_usd AS edition_fmv_usd,
    panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one) AS premium_mult,
    round(f.fmv_usd * panini_serial_premium_mult(s.is_jersey_mint, s.is_perfect_mint, s.is_number_one)) AS serial_fmv_usd
   FROM panini_card_serials s
     LEFT JOIN panini_editions e ON e.external_id = s.edition_external_id
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd
           FROM panini_fmv_snapshots fs
          WHERE fs.edition_id = e.id
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON true
  WHERE s.is_special;

ALTER VIEW public.panini_special_serials_board SET (security_invoker = on);

COMMENT ON COLUMN public.panini_special_serials_board.is_listed IS
  'DERIVED 2026-08-04, not passed through. True iff serial_ask_usd > 0. The upstream panini_card_serials.is_listed is constant true on all 59,425 rows (zero false, zero NULL) while only 34.5% carry an ask, so passing it through published "listed = true" on 4,049 of this board 6,525 rows -- 62.1% -- for cards with no ask. A positive ask is the only listing evidence this pipeline actually has.';

COMMENT ON COLUMN public.panini_card_serials.is_listed IS
  'KNOWN CONSTANT -- DO NOT USE AS A PREDICATE OR PUBLISH. Measured 2026-08-04: true on all 59,425 rows, zero false, zero NULL, while 38,954 of them have no positive ask. It carries no information. Use COALESCE(price_usd,0) > 0 instead. panini_deal_board still references it but harmlessly, as a no-op term next to price_usd > 0; panini_special_serials_board no longer passes it through.';