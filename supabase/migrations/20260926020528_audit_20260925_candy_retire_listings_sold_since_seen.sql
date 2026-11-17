-- audit_20260925_candy_retire_listings_sold_since_seen
--
-- PHANTOM CANDY ASKS: a listing whose token has SOLD since we last saw it.
--
-- Measured 2026-09-25 ~7:10 PM PT. `candy-listings-indexer` deactivates only on
-- POSITIVE evidence (delist / fill events from Magic Eden's activities feed, plus
-- expiry, plus a 1-of-1 supersede) — deliberately never on absence, because a
-- short ME answer once wiped 419 live asks (2026-07-27). But the activities feed
-- is a 1,000-event window per tick, so a fill it never shows leaves the ask
-- "active" forever. Result:
--   candy_listings       249 active rows not seen in >24 h; 163 of their tokens
--                        have a recorded SALE after the listing's last_seen_at.
--                        20 of 124 editions had their floor SET by such a row;
--                        the real (fresh) floor averaged 1.65x the phantom one.
--   candy_pack_listings  24 of 37 active rows stale (oldest last seen 2026-07-27);
--                        14 of their tokens sold since. The pack floor ($26.85,
--                        last seen 07-30) was one of them — packs trade $51-80.
--
-- A sale of the token after we last saw its ask is POSITIVE evidence the ask is
-- dead (the token changed hands), from our own `sales` / `candy_pack_sales` — the
-- same evidence standard the indexer already holds itself to, from a second source.
-- It cannot retire a live ask: a relist by the new owner is a NEW listing account
-- (new pda_address) first seen after the sale, so `sold_at > last_seen_at` is false
-- for it.
--
-- Called by the indexer every tick (after its own deactivations) and once here as
-- the repair. Returns the counts so the caller can report them.
--
-- Rollback: DROP FUNCTION public.candy_retire_listings_sold_since_seen();
--   The repaired rows can be re-activated only by re-listing (their tokens moved);
--   the exact set is recoverable as: is_active=false AND a sale after last_seen_at.

CREATE OR REPLACE FUNCTION public.candy_retire_listings_sold_since_seen()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cards integer;
  v_packs integer;
BEGIN
  UPDATE candy_listings l
     SET is_active = false
   WHERE l.is_active
     AND EXISTS (
       SELECT 1 FROM sales s
        WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
          AND s.nft_id = l.token_mint
          AND s.sold_at > l.last_seen_at
     );
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  UPDATE candy_pack_listings pl
     SET is_active = false
   WHERE pl.is_active
     AND EXISTS (
       SELECT 1 FROM candy_pack_sales ps
        WHERE ps.token_mint = pl.token_mint
          AND ps.sold_at > pl.last_seen_at
     );
  GET DIAGNOSTICS v_packs = ROW_COUNT;

  RETURN jsonb_build_object('cards_retired', v_cards, 'packs_retired', v_packs);
END;
$$;

-- anon-exec: revoked (candy_retire_listings_sold_since_seen) — a WRITE; service_role only.
REVOKE EXECUTE ON FUNCTION public.candy_retire_listings_sold_since_seen() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_retire_listings_sold_since_seen() TO postgres, service_role;

-- The repair.
SELECT public.candy_retire_listings_sold_since_seen();
