-- audit_20261120_candy_market_daily_phantom_window_nulled
--
-- APPROVED by Trevor 2026-11-20 ~8:30 PM PT in chat: "Yes, blank it" (after the question: should the Candy
-- edition market-history rows recorded while ~9.4k phantom asks were active show "—" instead of wrong numbers).
-- Applied by Claude Code cloud.
--
-- WHY: candy_edition_market_daily (one row per edition per PT day; drawn by every Candy edition page's market-
-- history chart: CandyMarketHistorySection → lib/candy/edition-market-history.ts → get_candy_edition_market_history)
-- recorded floor ask and listed count off candy_listings while it held pre-migration PHANTOM Magic Eden asks
-- (sellers = Candy's old custody wallets; the cards sit in users' new wallets). They were retired at the 2026-11-20
-- 7:35 PM PT candy-listings-indexer run (owner_moved_at >= 2026-11-21 00:47:54 UTC; 9,426 rows) by
-- candy_retire_listings_owner_moved (20261121004754 → 20261121012809). Same remedy as 20261108183038: the affected
-- values become NULL (unknown, not a value); the chart renders "—". Offers untouched.
--
-- SCOPE (narrower than the 13,765-row estimate given at approval time, measured 8:31 PM PT): a row is blanked only
-- if, on its PT day, a since-retired phantom ask for that edition had ALREADY been first seen, and the row shows a
-- floor or a NON-ZERO listed count. 16,471 rows / 3,388 editions / 11-15 → 11-20 (all 13,302 floor rows +
-- 3,169 non-zero counts). Kept: 7,291 "0 listed" rows from before any phantom for that edition appeared — those are
-- true. The 11-21 row onward is clean without this (the writer reads candy_listings at 5:43 AM PT).
--
-- Backup: public.audit_20261120_candy_market_daily_phantom_backup (RLS on, no grants).
-- REVERT:
--   UPDATE public.candy_edition_market_daily d SET floor_ask_usd = b.floor_ask_usd, listed_count = b.listed_count
--     FROM public.audit_20261120_candy_market_daily_phantom_backup b WHERE d.edition_id = b.edition_id AND d.day = b.day;

CREATE TABLE public.audit_20261120_candy_market_daily_phantom_backup AS
SELECT d.edition_id, d.day, d.floor_ask_usd, d.listed_count
  FROM public.candy_edition_market_daily d
 WHERE d.day BETWEEN '2026-11-14' AND '2026-11-20'
   AND (d.floor_ask_usd IS NOT NULL OR coalesce(d.listed_count, 0) > 0)
   AND EXISTS (SELECT 1 FROM public.candy_listings l
                WHERE l.edition_id = d.edition_id
                  AND l.owner_moved_at >= '2026-11-21 00:47:54+00'
                  AND (l.first_seen_at AT TIME ZONE 'America/Los_Angeles')::date <= d.day);
ALTER TABLE public.audit_20261120_candy_market_daily_phantom_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261120_candy_market_daily_phantom_backup FROM PUBLIC, anon, authenticated;

DO $chk$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261120_candy_market_daily_phantom_backup;
  IF n NOT BETWEEN 15000 AND 18000 THEN
    RAISE EXCEPTION 'scope check: % rows in backup, expected ~16,471 — stop and re-measure', n;
  END IF;
END
$chk$;

UPDATE public.candy_edition_market_daily d
   SET floor_ask_usd = NULL, listed_count = NULL
  FROM public.audit_20261120_candy_market_daily_phantom_backup b
 WHERE d.edition_id = b.edition_id AND d.day = b.day;
