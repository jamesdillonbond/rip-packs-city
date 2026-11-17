-- 2026-10-25 — the concierge's FMV distribution covers the WHOLE filter, not the
-- first 500 editions in catalog order.
--
-- WHY: fetchFmvDistribution (lib/concierge/fmv-distribution.ts) reads at most 500
-- editions in external_id order and computes p10/p50/p90/min/max over that slice.
-- The cap existed because the per-edition latest-FMV read was the expensive half;
-- edition_fmv_current (one row per edition) removes that cost. A replay of a real
-- question ("What is a Base Set common worth on Top Shot? Give me the range.")
-- showed the slice is not representative — measured 2026-10-25, Top Shot Base Set
-- COMMON, 4,047 matched / 4,017 priced:
--     first-500 slice:  p10 0.19  p50 0.21  p90 0.73  max   18.17
--     whole filter:     p10 0.20  p50 0.26  p90 2.00  max  719.10
-- The tool disclosed the truncation honestly; the answer was still the wrong range.
--
-- WHAT: one read over every matched canonical edition joined to
-- edition_fmv_current — the same predicates as the tool's applyCatalogFilters
-- (non-empty player_name; collection; player_id else ILIKE player; ILIKE set;
-- tier), the same Top Shot canonical-key rule as keepCanonicalEditionRows
-- (^[0-9]+:[0-9]+), and percentile_cont, which is the tool's own linear-
-- interpolation quantile. Verified equal to the tool on an untruncated filter
-- (Damian Lillard RARE: 18 editions, p10 4.85 / p50 12.00 / p90 60.32, min 4.25,
-- max 153). Cost: 55 ms / 18,839 buffers (all hits) for the 4,047-edition filter.
-- Returns the highest-FMV edition too, so the answer can name it.
--
-- Revert: DROP FUNCTION public.concierge_fmv_population_stats(uuid, uuid, text, text, text);
-- (the route falls back to the capped slice + truncation note when the call fails).

CREATE OR REPLACE FUNCTION public.concierge_fmv_population_stats(
  p_collection_id uuid,
  p_player_id uuid,
  p_player text,
  p_set text,
  p_tier text
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT e.id, e.external_id, e.player_name, e.set_name, e.tier::text AS tier
    FROM public.editions e
    WHERE e.player_name IS NOT NULL AND e.player_name <> ''
      AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      AND (p_player_id IS NULL OR e.player_id = p_player_id)
      AND (p_player_id IS NOT NULL OR p_player IS NULL OR e.player_name ILIKE '%' || p_player || '%')
      AND (p_set IS NULL OR e.set_name ILIKE '%' || p_set || '%')
      AND (p_tier IS NULL OR e.tier::text = upper(p_tier))
      AND (e.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid OR e.external_id ~ '^[0-9]+:[0-9]+')
  ),
  priced AS (
    SELECT m.*, f.fmv_usd, f.confidence::text AS confidence, f.computed_at
    FROM m JOIN public.edition_fmv_current f ON f.edition_id = m.id
    WHERE f.fmv_usd IS NOT NULL
  ),
  top AS (
    SELECT * FROM priced ORDER BY fmv_usd DESC, external_id LIMIT 1
  )
  SELECT jsonb_build_object(
    'matched', (SELECT count(*) FROM m),
    'priced',  (SELECT count(*) FROM priced),
    'p10',     (SELECT percentile_cont(0.1) WITHIN GROUP (ORDER BY fmv_usd) FROM priced),
    'p50',     (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY fmv_usd) FROM priced),
    'p90',     (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY fmv_usd) FROM priced),
    'min_fmv', (SELECT min(fmv_usd) FROM priced),
    'max_fmv', (SELECT max(fmv_usd) FROM priced),
    'top', (SELECT jsonb_build_object(
              'edition_id', t.id, 'external_id', t.external_id, 'player_name', t.player_name,
              'set_name', t.set_name, 'tier', t.tier, 'fmv_usd', t.fmv_usd,
              'confidence', t.confidence, 'computed_at', t.computed_at) FROM top t)
  );
$function$;

-- anon-exec: revoked (concierge_fmv_population_stats) — new function; the concierge reads it with the service role only.
REVOKE ALL ON FUNCTION public.concierge_fmv_population_stats(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.concierge_fmv_population_stats(uuid, uuid, text, text, text) TO service_role;
