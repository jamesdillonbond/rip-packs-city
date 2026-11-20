-- ⚠ TIME NOTE (file only): applied at 8:11 AM PT 11-20; the "~8:25 AM" below was an estimate.
--
-- 2026-11-20 (PT, ~8:25 AM) — get_top_movers: probe `sales` only for the rows it returns.
--
-- WHY. /api/profile/top-movers timed out at its 25 s bound for the 15.8k-moment wallet
-- (Vercel: 11-18 10:59 PM PT, 11-20 5:39 AM PT). The function checked "did this edition
-- trade inside the window" for EVERY owned edition before ranking: 10,517 index probes
-- into sales_2026 for that wallet (34k of the call's 98.5k buffers, and 5,978 of its
-- 6,993 cold block reads = 6.9 s of an 8.3 s cold call). It needs that answer for ten rows.
--
-- WHAT. Same result, different order of work: build the candidate set (owned editions with
-- a sales-backed current price and a DIFFERENT price p_days ago), sort it by delta, and
-- test the sale-in-window condition down that sorted list until five pass. `OFFSET 0`
-- keeps the planner from flattening the sorted subquery, so LIMIT 5 stops the probes.
-- `l.fmv_usd <> p.fmv_usd` is not a new filter: gainers kept delta > 0 and losers delta < 0.
-- Ties now break on edition_id (they were arbitrary before).
--
-- MEASURED (same wallet, warm, EXPLAIN ANALYZE BUFFERS): 98,494 → 59,574 buffers; sales
-- probes 10,517 → 15. EQUIVALENCE over 11 wallets (6 largest + 5 small), 110 rows: the
-- gainer and loser delta lists are identical for all 11; 9 are byte-identical and 2 differ
-- only in which edition is shown among equal deltas.
--
-- anon-exec: unchanged (get_top_movers) — CREATE OR REPLACE with the same signature; invoker-rights (not SECURITY DEFINER); has_function_privilege read before apply: anon=true, authenticated=true, service_role=true, preserved.
--
-- Revert: re-apply the function body from
-- 20260904041544_audit_20260904_get_top_movers_requires_sales_backed_price_and_a_sale_in_window.sql
-- (live prosrc md5 before this migration: d1f571c01b2f969dbaa015876520c999).

DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_top_movers(text,integer,uuid)'::regprocedure) <> 'd1f571c01b2f969dbaa015876520c999' THEN
    RAISE EXCEPTION 'get_top_movers drifted since it was read; re-derive before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_top_movers(p_wallet text, p_days integer DEFAULT 7, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_threshold timestamptz := now() - (p_days || ' days')::interval;
  v_result json;
BEGIN
  WITH owned AS MATERIALIZED (
    SELECT DISTINCT e.id AS edition_id, e.player_name, e.set_name
    FROM wallet_moments_cache wmc
    JOIN editions e
      ON e.external_id = wmc.edition_key
     AND e.collection_id = wmc.collection_id   -- external_id is only unique PER COLLECTION
     AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
    WHERE wmc.wallet_address = p_wallet
      AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
  ),
  -- Every owned edition whose price is sales-backed now and was DIFFERENT p_days ago.
  -- 2026-09-04: the current price must be sales-backed (not STALE / NO_DATA / ASK_ONLY).
  cand AS MATERIALIZED (
    SELECT
      o.edition_id, o.player_name, o.set_name,
      l.fmv_usd AS current_fmv, p.fmv_usd AS past_fmv,
      (l.fmv_usd - p.fmv_usd) AS delta,
      CASE WHEN p.fmv_usd > 0 THEN ((l.fmv_usd - p.fmv_usd) / p.fmv_usd) * 100 ELSE NULL END AS pct_change
    FROM owned o
    JOIN edition_fmv_current l ON l.edition_id = o.edition_id
    JOIN LATERAL (
      SELECT fs.fmv_usd
      FROM fmv_snapshots fs
      WHERE fs.edition_id = o.edition_id
        AND fs.computed_at <= v_threshold
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) p ON true
    WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL
      AND l.confidence IN ('HIGH','MEDIUM','LOW','SALES_ONLY')
      AND l.fmv_usd <> p.fmv_usd
  ),
  -- 2026-09-04: a mover is an edition whose MARKET moved, so it must have traded inside the
  -- window. 2026-11-20: that test runs down the SORTED list and stops at five (OFFSET 0 keeps
  -- the sorted subquery from being flattened), instead of once per owned edition.
  gainers AS (
    SELECT c.* FROM (SELECT * FROM cand WHERE delta > 0 ORDER BY delta DESC, edition_id OFFSET 0) c
    WHERE EXISTS (SELECT 1 FROM sales s WHERE s.edition_id = c.edition_id AND s.sold_at > v_threshold)
    ORDER BY c.delta DESC, c.edition_id LIMIT 5
  ),
  losers AS (
    SELECT c.* FROM (SELECT * FROM cand WHERE delta < 0 ORDER BY delta ASC, edition_id OFFSET 0) c
    WHERE EXISTS (SELECT 1 FROM sales s WHERE s.edition_id = c.edition_id AND s.sold_at > v_threshold)
    ORDER BY c.delta ASC, c.edition_id LIMIT 5
  )
  SELECT json_build_object(
    'gainers', COALESCE((SELECT json_agg(row_to_json(g)) FROM gainers g), '[]'::json),
    'losers',  COALESCE((SELECT json_agg(row_to_json(l)) FROM losers l), '[]'::json)
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
