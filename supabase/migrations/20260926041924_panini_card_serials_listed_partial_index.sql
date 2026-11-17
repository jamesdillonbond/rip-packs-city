-- panini_card_serials_listed_partial_index
--
-- Backs panini_market_board (20260926041904), read by /api/market's Panini arm on every Market
-- tab load. Without it the board's ask aggregate seq-scanned panini_card_serials (272k rows)
-- to find ~17k listed ones. Measured 2026-09-25 ~9:45 PM PT, warm, same query
-- (`select * from panini_market_board order by low_ask_usd limit 500`):
--   before  46,163 buffers on the serials leg · 75,436 total · 193.7 ms
--   after    1,953 buffers (Index Only Scan, 0 heap fetches) · 31,226 total · 65.5 ms
-- 1,160 kB. Built plain (not CONCURRENTLY): ms on this size.
--
-- REVERT: DROP INDEX IF EXISTS public.idx_panini_serials_listed_edition;

CREATE INDEX IF NOT EXISTS idx_panini_serials_listed_edition
  ON public.panini_card_serials (edition_external_id) INCLUDE (price_usd, captured_at)
  WHERE is_listed AND price_usd > 0;
