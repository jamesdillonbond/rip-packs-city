-- audit_20261110_panini_confirmed_low_asks_keyed
--
-- WHY (2-h pgss delta 10:05 AM -> 12:05 PM PT, Claude Code cloud autonomous pass): the live-ask resolver
-- (lib/asks/edition-live-ask.ts -> /api/best-asks, /api/alerts, the edition page, the concierge, recent-low) read
-- Panini asks as `panini_market_board?external_id=in.(...)` -- 13 calls, 12.0 s / 12k blocks read EACH. The view's
-- `asks` CTE groups EVERY listed serial confirmed in 7 days; an `= ANY(...)` filter on the joined edition key is not
-- pushed into that aggregate (only a single `=` constant propagates through the join's equivalence class, which is
-- why the edition page's `.eq` read stays fast). Measured: 3 keys -> 283,036 serials aggregated into 36,849 groups,
-- 61,701 buffers / 5.0 s, to return 3 rows.
--
-- WHAT. A keyed read with the SAME rule as panini_market_board.low_ask_usd: for each requested key that is a Panini
-- edition (panini_editions joined to editions in the Panini collection, as the view joins), the minimum price_usd over
-- serials that are is_listed, price_usd > 0 and captured_at within 7 days; keys with no such serial return no row
-- (the view has no row for them either). One probe per key on idx_panini_serials_listed_edition (its partial predicate
-- is exactly is_listed AND price_usd > 0; captured_at is INCLUDEd). The view stays the definition for full-board
-- readers (/api/market, the edition page, edition_live_ask); this function is only the keyed path.
--
-- anon-exec: revoked (panini_confirmed_low_asks) -- new function; REVOKE FROM PUBLIC, anon, authenticated below; service_role only, like every panini_* read.
-- REVERT: DROP FUNCTION public.panini_confirmed_low_asks(text[]); and point lib/asks/edition-live-ask.ts back at
--         .from("panini_market_board").select("external_id, low_ask_usd").in("external_id", slice)

CREATE OR REPLACE FUNCTION public.panini_confirmed_low_asks(p_external_ids text[])
RETURNS TABLE (external_id text, low_ask_usd numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT pe.external_id, a.low_ask_usd
    FROM (SELECT DISTINCT k FROM unnest(p_external_ids) AS k WHERE k IS NOT NULL) ks
    JOIN public.panini_editions pe ON pe.external_id = ks.k
    JOIN public.editions e ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid AND e.external_id::text = pe.external_id
    CROSS JOIN LATERAL (
      SELECT min(s.price_usd) AS low_ask_usd
        FROM public.panini_card_serials s
       WHERE s.edition_external_id = pe.external_id
         AND s.is_listed AND s.price_usd > 0::numeric
         AND s.captured_at > (now() - '7 days'::interval)
    ) a
   WHERE a.low_ask_usd IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.panini_confirmed_low_asks(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_confirmed_low_asks(text[]) TO service_role;
