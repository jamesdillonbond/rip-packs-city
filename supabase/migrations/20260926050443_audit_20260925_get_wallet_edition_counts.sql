-- Per-edition {owned, locked} for one wallet + collection, aggregated IN SQL
-- (2026-09-25). Replaces /api/wallet/edition-counts' JS loop, which paged rows
-- 1000 at a time by OFFSET and stopped after ~51 pages: 3 live wallets hold more
-- than 50k moments in one collection (largest 153,544), so every edition past
-- the cap read as "Owned: 0" — a fabricated zero on Market, Sniper and the
-- player-page tiles. Shape: owned from the covering (wallet, collection,
-- edition_key) index (index-only), locked from the is_locked partial index.
-- Measured on the 153,544-moment wallet: 2.0 s / ~103k buffers, 8,168 editions,
-- vs 23.6 s / ~581k buffers for a single GROUP BY that heap-fetched is_locked.
-- Returns ONE jsonb value, so PostgREST's 1000-row cap cannot truncate it.
-- p_wallet must already be normalized by the caller (lib/address normalizeAddress:
-- Cadence/EVM lowercased, base58 verbatim) — this function does not fold it.
CREATE FUNCTION public.get_wallet_edition_counts(p_wallet text, p_collection_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH o AS (
    SELECT edition_key, count(*) AS owned
    FROM wallet_moments_cache
    WHERE wallet_address = p_wallet AND collection_id = p_collection_id AND edition_key IS NOT NULL
    GROUP BY edition_key
  ),
  l AS (
    SELECT edition_key, count(*) AS locked
    FROM wallet_moments_cache
    WHERE wallet_address = p_wallet AND collection_id = p_collection_id AND is_locked AND edition_key IS NOT NULL
    GROUP BY edition_key
  )
  SELECT coalesce(
    jsonb_object_agg(o.edition_key, jsonb_build_object('owned', o.owned, 'locked', coalesce(l.locked, 0))),
    '{}'::jsonb
  )
  FROM o LEFT JOIN l USING (edition_key);
$$;

-- anon-exec: revoked (get_wallet_edition_counts) — new function; only the service-role /api/wallet/edition-counts route calls it, so PUBLIC, anon and authenticated are revoked in one statement.
REVOKE EXECUTE ON FUNCTION public.get_wallet_edition_counts(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_edition_counts(text, uuid) TO postgres, service_role;
