-- audit_20261025: RECORD-ONLY. idx_panini_serials_offer_edition was built with CREATE INDEX CONCURRENTLY from a
-- one-off pg_cron job (2026-10-25 9:52–9:54 PM PT, 112 s, 36 MB, indisvalid = true), under a temporarily raised
-- postgres statement_timeout that was RESET straight after (rolconfig back to search_path only; both one-off jobs
-- unscheduled; active job count back to 256). In prod this file is a no-op that asserts the index is valid.
--
-- Why: a per-edition max(best_offer_usd) over panini_card_serials was a 46 s / ~744k-block scan; with this partial
-- index it is index-only (~5 s cold). It serves the edition page's Offers section (edition_external_id + best_offer
-- > 0 + captured_at) and any later per-edition offer read. The Bid vs Floor board does NOT need it (it reads the
-- listed-serial cover index).
--
-- Revert: DROP INDEX CONCURRENTLY public.idx_panini_serials_offer_edition;  (from a one-off pg_cron job or the SQL editor)

CREATE INDEX IF NOT EXISTS idx_panini_serials_offer_edition ON public.panini_card_serials (edition_external_id) INCLUDE (best_offer_usd, captured_at) WHERE best_offer_usd > 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_panini_serials_offer_edition' AND i.indisvalid AND i.indisready
  ) THEN
    RAISE EXCEPTION 'idx_panini_serials_offer_edition is missing or not valid';
  END IF;
END $$;
