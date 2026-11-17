-- audit_20261019: edition_live_ask probes the All Day / Candy floor views by edition id.
--
-- Measured 2026-10-19 ~9:00 PM PT: every call cost ~8.0k execution + ~2.3k planning buffers
-- (~70 ms) on ANY collection, because `view JOIN ed ON view.edition_id = ed.id` let the planner
-- materialise allday_edition_floor_ask (all ~26.7k open All Day listings, 5,431 buffers) and
-- candy_listing_floor (2,564) before joining one edition. A scalar `edition_id = (SELECT id FROM
-- ed)` is pushed into both views (All Day 5,431 -> 17 buffers; Candy 2,564 -> 1,125, the rest is
-- that view's tier-median aggregate). Same rows: ed holds at most one row, and no edition -> NULL
-- -> no rows, as the join gave. Body otherwise = 20261020031908. Pin: supabase/tests/edition_live_ask.sql.
--
-- anon-exec: unchanged (edition_live_ask) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
--
-- Revert: re-apply the CREATE OR REPLACE in 20261020031908_audit_20261019_edition_live_ask_reads_panini_confirmed_ask.sql.

CREATE OR REPLACE FUNCTION public.edition_live_ask(p_collection_id uuid, p_edition_key text)
 RETURNS TABLE(ask numeric, source text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The LIVE low ask of ONE edition: what a buyer would pay now. The SQL twin of
  -- lib/asks/edition-live-ask.ts (resolveLiveAsks); keep the two rules identical.
  --   priority 1: allday_edition_floor_ask (ghost listings excluded) / candy_listing_floor.confirmed_floor_usd
  --               / panini_market_board.low_ask_usd (Panini: lowest ask re-confirmed in 7 d; 2026-10-19)
  --   priority 2: edition_offers.low_ask last SEEN (low_ask_confirmed_at) within 7 days
  --   priority 3: badge_editions.low_ask updated within 7 days
  -- An ask is returned only when the edition has an FMV and the ask is <= 3x it
  -- (the estate's disconnected-ask multiple). No row = no usable ask, never 0.
  WITH ed AS (
    SELECT e.id FROM public.editions e
     WHERE e.collection_id = p_collection_id AND e.external_id = p_edition_key
     LIMIT 1
  ), fmv AS (
    SELECT f.fmv_usd FROM public.edition_fmv_current f JOIN ed ON f.edition_id = ed.id
     WHERE f.fmv_usd > 0
  ), cand AS (
    -- A SCALAR edition id, not a JOIN: the planner pushes it into both floor
    -- views (DISTINCT ON / GROUP BY edition_id) instead of materialising every
    -- open listing first (2026-10-19: ~10k buffers / 70 ms per call -> ~1.2k).
    SELECT a.floor_ask AS ask, 'allday_floor'::text AS source, 1 AS pri
      FROM public.allday_edition_floor_ask a WHERE a.edition_id = (SELECT ed.id FROM ed)
    UNION ALL
    SELECT c.confirmed_floor_usd, 'candy_confirmed_floor', 1
      FROM public.candy_listing_floor c WHERE c.edition_id = (SELECT ed.id FROM ed)
    UNION ALL
    SELECT m.low_ask_usd, 'panini_confirmed_ask', 1
      FROM public.panini_market_board m
     WHERE m.external_id = p_edition_key
       AND EXISTS (SELECT 1 FROM public.collections pc
                    WHERE pc.id = p_collection_id AND pc.slug = 'panini_blockchain')
    UNION ALL
    SELECT o.low_ask, 'edition_offers', 2
      FROM public.edition_offers o
     WHERE o.collection_id = p_collection_id AND o.external_id = p_edition_key
       AND o.low_ask_confirmed_at > now() - interval '7 days'
    UNION ALL
    SELECT b.low_ask, 'badge_editions', 3
      FROM public.badge_editions b
     WHERE b.collection_id = p_collection_id AND b.external_id = p_edition_key
       AND b.updated_at > now() - interval '7 days'
  )
  SELECT cand.ask, cand.source
    FROM cand CROSS JOIN fmv
   WHERE cand.ask > 0 AND cand.ask <= fmv.fmv_usd * 3
   ORDER BY cand.pri, cand.ask
   LIMIT 1;
$function$;
