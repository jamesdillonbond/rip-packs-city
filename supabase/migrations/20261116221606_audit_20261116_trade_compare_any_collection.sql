-- 2026-11-16 (PT) — /trades/compare widens to All Day and Golazos (Trevor: "Keep going").
--
-- get_topshot_trade_compare(a, b, limit) (migration 20261116180340, same day) generalised to any
-- collection: get_trade_compare(collection_id, a, b, limit), the SAME body with the Top Shot uuid
-- made a parameter. Its only caller (lib/trade-compare/read.ts) moves to it in the same push; the
-- Top Shot-only function is dropped by a FOLLOW-UP migration once that deploy is live (dropping it
-- here would 503 the live page for the minutes between this migration and the deploy).
--
-- Per collection the candidate rule is unchanged: duplicates one wallet holds in an EXACT edition
-- the other has no copy of, skipping copies RPC last saw locked (All Day / Golazos rows carry
-- is_locked false or NULL — both are candidates). The route decides tradeable from the chain.
--
-- SECURITY INVOKER; service_role only.
-- Revert: DROP FUNCTION public.get_trade_compare(uuid, text, text, int);

CREATE OR REPLACE FUNCTION public.get_trade_compare(p_collection_id uuid, p_a text, p_b text, p_limit int DEFAULT 800)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH a AS MATERIALIZED (
    SELECT moment_id, edition_key, serial_number, player_name, set_name, tier, series_number,
           image_url, league, fmv_usd, fmv_confidence::text AS fmv_confidence, is_locked
    FROM wallet_moments_cache
    WHERE collection_id = p_collection_id
      AND wallet_address = p_a
      AND edition_key IS NOT NULL
  ),
  b AS MATERIALIZED (
    SELECT moment_id, edition_key, serial_number, player_name, set_name, tier, series_number,
           image_url, league, fmv_usd, fmv_confidence::text AS fmv_confidence, is_locked
    FROM wallet_moments_cache
    WHERE collection_id = p_collection_id
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

REVOKE EXECUTE ON FUNCTION public.get_trade_compare(uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_compare(uuid, text, text, int) TO postgres, service_role;
-- anon-exec: revoked (get_trade_compare) — reached only through /api/public/trades/compare, which rate-limits and chain-checks; no direct anon RPC.

