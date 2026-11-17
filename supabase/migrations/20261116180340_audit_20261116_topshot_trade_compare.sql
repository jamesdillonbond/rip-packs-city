-- 2026-11-16 (PT) — /trades/compare: "what could two collectors trade?" (Trevor, after a live
-- read of thetradefloor.pages.dev: "Keep going and working on this").
--
-- For two Top Shot wallets, the Moments EACH holds a duplicate of in an edition the OTHER does
-- not own at all — the trade candidates. One call, both directions, one scan per wallet over
-- idx_wmc_wallet_coll_ek_fmv_tier / idx_wmc_lock_wallet_coll (EXPLAIN 2026-11-16, 0x01d7…
-- (4,952 rows) vs 0xbd94… (15,305): 2.4 s cold, 17.6k buffers; 531 candidate rows in 191
-- editions — thetradefloor's chain read of the same pair showed 178).
--
-- This is the CANDIDATE list, not the truth. The route reads the chain for every candidate
-- (held, locked — lib/giveaways/topshot-holdings.ts — and listed for sale —
-- lib/trade-room/topshot-listed.ts) before it shows anything as tradeable.
--   · `owned` counts EVERY copy of the edition the holder has in RPC's index, locked or not,
--     so "keep one" is computed against the whole holding.
--   · A copy RPC last saw LOCKED is not offered as a candidate (cached_locked counts them) —
--     the chain is read only for the rest. The one miss this leaves: a Moment that UNLOCKED
--     since RPC's last lock check. The page says so.
--   · "The other side doesn't own it" is read from RPC's index of THAT wallet; the route
--     compares the index's size with the chain's getIDs() length and says when it is short.
--   · Exact edition: a parallel (`::N` key) is its own edition, as on Top Shot.
--
-- fmv_confidence is returned for the SERVER (Quick Trade balances only on confident prices);
-- the route never sends it to a browser (FMV confidence is internal, 2026-10-18).
--
-- jsonb return: no PostgREST 1,000-row clamp; *_total carries the whole population so a
-- capped list is labelled, never read as complete.
--
-- SECURITY INVOKER; called by the route's service-role client only.
-- Revert: DROP FUNCTION public.get_topshot_trade_compare(text, text, int);

CREATE OR REPLACE FUNCTION public.get_topshot_trade_compare(p_a text, p_b text, p_limit int DEFAULT 800)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH a AS MATERIALIZED (
    SELECT moment_id, edition_key, serial_number, player_name, set_name, tier, series_number,
           image_url, league, fmv_usd, fmv_confidence::text AS fmv_confidence, is_locked
    FROM wallet_moments_cache
    WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND wallet_address = p_a
      AND edition_key IS NOT NULL
  ),
  b AS MATERIALIZED (
    SELECT moment_id, edition_key, serial_number, player_name, set_name, tier, series_number,
           image_url, league, fmv_usd, fmv_confidence::text AS fmv_confidence, is_locked
    FROM wallet_moments_cache
    WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND wallet_address = p_b
      AND edition_key IS NOT NULL
  ),
  a_ed AS (
    SELECT edition_key, count(*) AS owned, count(*) FILTER (WHERE is_locked IS TRUE) AS cached_locked
    FROM a GROUP BY edition_key HAVING count(*) >= 2
  ),
  b_ed AS (
    SELECT edition_key, count(*) AS owned, count(*) FILTER (WHERE is_locked IS TRUE) AS cached_locked
    FROM b GROUP BY edition_key HAVING count(*) >= 2
  ),
  a_c AS (
    SELECT a.*, e.owned, e.cached_locked
    FROM a JOIN a_ed e USING (edition_key)
    WHERE a.is_locked IS NOT TRUE
      AND NOT EXISTS (SELECT 1 FROM b WHERE b.edition_key = a.edition_key)
  ),
  b_c AS (
    SELECT b.*, e.owned, e.cached_locked
    FROM b JOIN b_ed e USING (edition_key)
    WHERE b.is_locked IS NOT TRUE
      AND NOT EXISTS (SELECT 1 FROM a WHERE a.edition_key = b.edition_key)
  )
  SELECT jsonb_build_object(
    'a_indexed', (SELECT count(*) FROM a),
    'b_indexed', (SELECT count(*) FROM b),
    'a_total', (SELECT count(*) FROM a_c),
    'b_total', (SELECT count(*) FROM b_c),
    'a_rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) - 'is_locked')
      FROM (SELECT * FROM a_c ORDER BY fmv_usd DESC NULLS LAST, edition_key, serial_number DESC, moment_id LIMIT p_limit) x
    ), '[]'::jsonb),
    'b_rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) - 'is_locked')
      FROM (SELECT * FROM b_c ORDER BY fmv_usd DESC NULLS LAST, edition_key, serial_number DESC, moment_id LIMIT p_limit) x
    ), '[]'::jsonb)
  )
$$;

REVOKE EXECUTE ON FUNCTION public.get_topshot_trade_compare(text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_trade_compare(text, text, int) TO postgres, service_role;
-- anon-exec: revoked (get_topshot_trade_compare) — reached only through /api/public/trades/compare, which rate-limits and chain-checks; no direct anon RPC.
