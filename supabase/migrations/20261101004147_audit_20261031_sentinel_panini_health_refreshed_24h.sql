-- audit_20261031_sentinel_panini_health_refreshed_24h
-- Adds ONE key, `edition_refreshed_24h`, to the jsonb the sentinel's "Panini Ingest" arm reads.
--
-- WHY. The arm's rotation-tail leg warned at a FIXED 168 h. Since the 10-18 decision to give
-- priced products (World Cup Prizm) most of the known walk slots, the unpriced catalogue
-- rotates more slowly by design: measured 2026-10-31 ~5:45 PM PT, 4,078 of 40,153 editions
-- walked in 24 h = a ~236 h rotation, and the stalest edition sat at 225 h — i.e. the walk WAS
-- reaching the tail, on schedule. The leg had been WARN on every sentinel run since ~10-27
-- (173 h → 211 h → 225 h), a permanently-amber instrument that cannot tell a stall from the
-- designed rotation. The route now judges the tail AGAINST the measured rotation period
-- (editions ÷ edition_refreshed_24h × 24 h), which needs this count.
--
-- COST. Seq Scan of panini_editions: 2,523 shared hits, 17 ms (EXPLAIN ANALYZE BUFFERS,
-- 2026-10-31). The existing min/max legs already scan the same relation.
--
-- Body otherwise identical to 20260924140744 (prosrc verified equal before this edit).
-- anon-exec: unchanged (sentinel_panini_health) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
-- Revert: re-run the CREATE OR REPLACE body from 20260924140744 (drops the one key; the route
--   falls back to the absolute 168/336 h thresholds when the key is absent).

CREATE OR REPLACE FUNCTION public.sentinel_panini_health()
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'newest_walk_at',     (SELECT max(last_seen_at) FROM panini_editions),
    'edition_age_max_h',  (SELECT round((extract(epoch FROM now() - min(last_seen_at)) / 3600)::numeric, 1) FROM panini_editions),
    'editions',           (SELECT count(*) FROM panini_editions),
    'edition_refreshed_24h',
                          (SELECT count(*) FROM panini_editions WHERE last_seen_at > now() - interval '24 hours'),
    'max_serials_per_edition_26h',
                          (SELECT COALESCE(max(n), 0) FROM (
                             SELECT count(*) AS n FROM panini_card_serials
                              WHERE captured_at > now() - interval '26 hours'
                              GROUP BY edition_external_id) z),
    'newest_sale_at',     (SELECT max(last_sale_at) FROM panini_card_serials)
  )
$$;
