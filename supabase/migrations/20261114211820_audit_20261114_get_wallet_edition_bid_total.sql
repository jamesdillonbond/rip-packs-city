-- 2026-11-14 (~1:18 PM PT) — RENAME of 20261114205525 (whose name collided with the July concierge
-- function get_wallet_best_offer_total(text)); identical body. Read back (20261114211820):
-- 0xbd94cade097e50ac → 28,547.00 over 2,983 editions, paired FMV 38,764.04; anon EXECUTE false.
--
-- 2026-11-14 (~1:15 PM PT, Cowork cloud) — Trevor: "the math doesn't seem to make sense" on the
-- Collection tab. "Best Offer Total $16,452.00 · vs FMV −$31,204.98" (0xbd94cade097e50ac) was:
--   (1) a client sum over the rows LOADED SO FAR (the grid pages 50 at a time; a 15,758-moment
--       wallet is never fully loaded), published as the wallet's total;
--   (2) an EDITION bid counted once per COPY held — one bid fills once (445 multi-copy editions,
--       up to 132 copies of one: ~$5.9k of bids no buyer would pay);
--   (3) compared against the FMV of the WHOLE wallet, most of which carries no bid at all.
--
-- get_wallet_edition_bid_total is the wallet-wide answer: one bid per held edition, chosen by /api/best-offers'
-- own rule (the FRESHER of edition_offers / badge_editions wins; a datable row beats an undatable
-- one; neither datable → the higher bid), with the FMV of exactly those editions beside it so the
-- gap is like-for-like. Serial-grain offers are NOT included (the per-row grid still shows them).
-- Kept OUT of get_wallet_summary on purpose: that read is up to ~25 s cold on whales, and a
-- failure here must not cost the reader the whole summary.
--
-- Measured before apply (EXPLAIN ANALYZE, warm): 0xbd94cade097e50ac Top Shot — 207 ms,
-- 31,676 shared hits / 5 reads; 2,983 editions carry a bid of 7,963 held.
-- anon-exec: false — called only by /api/wallet-summary with the service role.
--
-- Read back after apply (20261114205525): 0xbd94cade097e50ac → total 28,541.00 over 2,983 editions, paired FMV
-- 38,768.05; anon EXECUTE false, service_role true. Control 0x5813c7fd815463ba Pinnacle → 0 editions
-- (Pinnacle offers live in marketplace_offers): the route therefore attaches these fields ONLY when
-- best_offer_editions > 0, so a collection this function cannot see never reads as "no bids".
--
-- Revert: DROP FUNCTION public.get_wallet_edition_bid_total(text, uuid); the client treats the
-- absent fields as "not known" and falls back to its complete-rows-only sum.
CREATE OR REPLACE FUNCTION public.get_wallet_edition_bid_total(p_wallet text, p_collection_id uuid)
RETURNS json
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH held AS (
    SELECT wmc.edition_key, MAX(wmc.fmv_usd) AS cached_fmv
    FROM wallet_moments_cache wmc
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = p_collection_id
      AND wmc.edition_key IS NOT NULL
    GROUP BY wmc.edition_key
  ),
  bid AS (
    SELECT h.edition_key, h.cached_fmv, pick.offer
    FROM held h
    LEFT JOIN edition_offers eo ON eo.collection_id = p_collection_id AND eo.external_id = h.edition_key
    LEFT JOIN badge_editions be ON be.collection_id = p_collection_id AND be.external_id = h.edition_key
    CROSS JOIN LATERAL (
      SELECT o.offer
      FROM (VALUES (eo.highest_offer, eo.updated_at), (be.highest_offer, be.updated_at)) o(offer, at)
      WHERE o.offer > 0
      ORDER BY o.at DESC NULLS LAST, o.offer DESC
      LIMIT 1
    ) pick
  ),
  priced AS (
    SELECT b.offer, COALESCE(lf.fmv_usd, b.cached_fmv) AS fmv
    FROM bid b
    LEFT JOIN editions e ON e.external_id = b.edition_key AND e.collection_id = p_collection_id
    LEFT JOIN edition_fmv_current lf ON lf.edition_id = e.id
  )
  SELECT json_build_object(
    'best_offer_total',        ROUND(COALESCE(SUM(offer), 0)::numeric, 2),
    'best_offer_editions',     COUNT(*),
    'best_offer_paired_fmv',   ROUND(COALESCE(SUM(fmv) FILTER (WHERE fmv IS NOT NULL), 0)::numeric, 2),
    'best_offer_paired_offer', ROUND(COALESCE(SUM(offer) FILTER (WHERE fmv IS NOT NULL), 0)::numeric, 2)
  )
  FROM priced;
$fn$;

REVOKE ALL ON FUNCTION public.get_wallet_edition_bid_total(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_edition_bid_total(text, uuid) TO service_role;
