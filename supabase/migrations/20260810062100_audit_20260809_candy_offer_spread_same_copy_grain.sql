-- audit_20260809_candy_offer_spread_same_copy_grain
--
-- D33 (deep-audit register). `candy_offer_spread_board` published a FABRICATED
-- bid-ask spread on the PUBLIC /insights/candy-mlb board.
--
-- THE DEFECT. `best_offer_usd` (from candy_best_offers) is a MINT-grain max bid
-- — a bid on one specific NFT — while `floor_usd` (from candy_listing_floor) is
-- an EDITION-grain min ask over a DIFFERENT copy. The view subtracted one from
-- the other and published the result as a single edition's spread.
--
-- Measured live 2026-08-09 before this migration:
--   * 33 rows carried both legs; only 2 had the top offer on the same mint as
--     the floor listing, and only 5 had the offered mint listed at all.
--     => 31 of 33 spread values (94%) priced two different NFTs.
--   * 7 of 33 (21.2%) were NEGATIVE — worst -91.9%, avg -54.4% among negatives
--     — which reads on a public board as "buy below the standing bid", i.e.
--     free money that does not exist. In all 7, the bid target was NOT LISTED.
--   * Comparing the SAME copy, ZERO books are crossed. Every negative was a
--     grain artifact, not a market condition.
--
-- ⚠ The offers data itself is CORRECT — candy_best_offers is a clean
--   GROUP BY edition_id / max(price_usd). Do NOT "fix" the offers pipeline.
--   The defect is purely in the derived metric.
--
-- ⚠ An earlier pass (P5, 2026-08-01) saw the crossed rows and CLAMPED the
--   displayed percentage at 0% client-side, treating it as a rendering problem.
--   That hid the symptom and left the cause — which is why this survived.
--
-- THE FIX. Drop `spread_usd` / `spread_pct` (they have no honest definition at
-- this grain) and replace them with:
--   * `floor_mint` / `best_offer_mint` — the grain made VISIBLE in the data, so
--     no future consumer can silently reconstruct the bad subtraction.
--   * `same_copy` — whether the two legs describe one NFT.
--   * `floor_copy_bid_usd` + `exec_spread_usd` / `exec_spread_pct` — a genuine
--     EXECUTABLE spread, measured on the floor copy only (the cheapest listed
--     NFT and the best standing bid on THAT SAME NFT), ask-denominated so it is
--     bounded and conventional. NULL when the cheapest copy carries no bid,
--     which is honest: there is no executable spread to quote. Populates 3 of
--     125 rows today and grows as the book thickens.
-- `floor_usd` and `best_offer_usd` are unchanged — each is individually correct
-- and useful; only their SUBTRACTION was meaningless.
--
-- Column removal requires DROP + CREATE (CREATE OR REPLACE cannot drop columns).
-- Verified 2026-08-09: pg_depend shows ZERO dependent views/matviews.
--
-- Revert:
--   DROP VIEW public.candy_offer_spread_board;
--   then re-create from 20260724160400_audit_20260724_candy_deals_spread_market.sql
--   (its candy_offer_spread_board block, verbatim) and re-apply the grants below.

DROP VIEW IF EXISTS public.candy_offer_spread_board;

CREATE VIEW public.candy_offer_spread_board
WITH (security_invoker = true) AS
WITH top_offer AS (
  -- The mint carrying the edition's highest active bid. Ordering matches
  -- candy_best_offers' max(price_usd) so best_offer_mint and best_offer_usd
  -- can never describe different offers; token_mint breaks price ties.
  SELECT DISTINCT ON (o.edition_id)
         o.edition_id,
         o.token_mint AS best_offer_mint
  FROM public.candy_offers o
  WHERE o.is_active
    AND (o.expiry IS NULL OR o.expiry > now())
  ORDER BY o.edition_id, o.price_usd DESC, o.token_mint
),
floor_mint AS (
  -- The mint carrying the edition's floor ask. Joining ON price = floor_usd
  -- inherits candy_listing_floor's troll-ceiling exclusion for free rather
  -- than re-deriving it here (two copies of that rule would be a second
  -- source of truth and could drift).
  SELECT DISTINCT ON (l.edition_id)
         l.edition_id,
         l.token_mint AS floor_mint
  FROM public.candy_listings l
  JOIN public.candy_listing_floor lf
    ON lf.edition_id = l.edition_id
   AND l.price_usd = lf.floor_usd
  WHERE l.is_active
  ORDER BY l.edition_id, l.token_mint
),
floor_copy_bid AS (
  -- Best standing bid on the floor copy ITSELF — the only like-for-like leg.
  SELECT fm.edition_id,
         max(o.price_usd) AS floor_copy_bid_usd
  FROM floor_mint fm
  JOIN public.candy_offers o
    ON o.token_mint = fm.floor_mint
   AND o.is_active
   AND (o.expiry IS NULL OR o.expiry > now())
  GROUP BY fm.edition_id
)
SELECT
  e.external_id,
  e.player_name,
  e.name                                   AS edition_name,
  e.tier::text                             AS tier,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  e.circulation_count,
  lf.floor_usd,
  lf.listing_count,
  bo.best_offer_usd,
  bo.distinct_bidders,
  fc.fmv_usd,
  -- Grain, exposed. The two headline figures usually describe different NFTs.
  fm.floor_mint,
  t.best_offer_mint,
  CASE WHEN fm.floor_mint IS NOT NULL AND t.best_offer_mint IS NOT NULL
       THEN (fm.floor_mint = t.best_offer_mint) END          AS same_copy,
  -- Executable spread, floor copy only. Ask-denominated: bounded at 100%,
  -- and answers "how far under the cheapest listed copy is a real bid on it?"
  fcb.floor_copy_bid_usd,
  CASE WHEN lf.floor_usd IS NOT NULL AND fcb.floor_copy_bid_usd IS NOT NULL
       THEN round(lf.floor_usd - fcb.floor_copy_bid_usd, 2) END AS exec_spread_usd,
  CASE WHEN lf.floor_usd IS NOT NULL AND lf.floor_usd > 0 AND fcb.floor_copy_bid_usd IS NOT NULL
       THEN round(100.0 * (lf.floor_usd - fcb.floor_copy_bid_usd) / lf.floor_usd, 1) END AS exec_spread_pct
FROM public.editions e
LEFT JOIN public.candy_listing_floor lf ON lf.edition_id = e.id
LEFT JOIN public.candy_best_offers   bo ON bo.edition_id = e.id
LEFT JOIN public.fmv_current         fc ON fc.edition_id = e.id
LEFT JOIN floor_mint     fm  ON fm.edition_id  = e.id
LEFT JOIN top_offer      t   ON t.edition_id   = e.id
LEFT JOIN floor_copy_bid fcb ON fcb.edition_id = e.id
WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  AND (lf.floor_usd IS NOT NULL OR bo.best_offer_usd IS NOT NULL);

COMMENT ON VIEW public.candy_offer_spread_board IS
  'Candy MLB per-edition ask floor and bid floor. floor_usd (edition-grain min ask) and '
  'best_offer_usd (mint-grain max bid) usually describe DIFFERENT NFTs — see same_copy. '
  'Never subtract them: that produced the D33 fabricated spread (7/33 rows negative). '
  'The only executable spread is exec_spread_*, measured on the floor copy alone. '
  'Neither leg is FMV.';

-- Normalize to `security_invoker=on`. CREATE ... WITH (security_invoker = true)
-- stores the literal `true`, but check_public_security_invariants()'s
-- view_unexpected_definer arm matches only `=on` — so a `=true` view reads as an
-- unexpected DEFINER view. Cowork normalized the other Candy views for exactly
-- this reason in audit_20260724_candy_view_invoker_normalize; match them.
ALTER VIEW public.candy_offer_spread_board SET (security_invoker = on);

-- DROP VIEW discarded the grants; restore the service-role-only posture.
REVOKE ALL ON public.candy_offer_spread_board FROM anon, authenticated;
GRANT SELECT ON public.candy_offer_spread_board TO service_role;
