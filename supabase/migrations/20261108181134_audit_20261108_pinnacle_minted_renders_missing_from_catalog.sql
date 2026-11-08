-- audit_20261108_pinnacle_minted_renders_missing_from_catalog
--
-- 2026-11-08 (Claude Code, Trevor's Windows box; handoff pinnacle-wmc-render-gap, fix 3).
-- pinnacle_catalog is filled from Dapper's studio-platform search
-- (/api/admin/backfill-pinnacle-catalog). When that source lags the pins the chain has actually
-- minted, a held pin's render_id has no catalog row, so its name / set / image cannot be derived
-- (derive_pinnacle_wmc_from_catalog) — and nothing said so. This read lets the backfill log it.
--
-- WHAT. pinnacle_minted_renders_missing_from_catalog(p_sample, p_recent_days): distinct render_ids
-- in RPC's own mint records (pinnacle_mint_events) with no pinnacle_catalog row, with how many pins
-- each covers, split into all-time and RECENT (first minted within p_recent_days) — the recent count
-- is the "source fell behind" signal; an old orphan is a standing oddity, reported but not alarmed.
-- Measured 11-08 (EXPLAIN ANALYZE BUFFERS): one parallel seq scan of 537,939 mint rows + the
-- 2,917-row catalog pkey, 12,205 buffers, 0.5 s; result 1 render (GEN-20CG-ALIN-S0, 1 pin, minted
-- 2026-01-30). Called once a day by the full catalog backfill.
--
-- PIN: supabase/tests/pinnacle_minted_renders_missing_from_catalog.sql.
-- anon-exec: NOT granted (pinnacle_minted_renders_missing_from_catalog) — read by the service-role catalog backfill only; EXECUTE revoked from PUBLIC, anon, authenticated and granted to service_role below.
-- REVERT: DROP FUNCTION public.pinnacle_minted_renders_missing_from_catalog(integer, integer);
--         (and revert the route change that calls it)

CREATE OR REPLACE FUNCTION public.pinnacle_minted_renders_missing_from_catalog(p_sample integer DEFAULT 10, p_recent_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH missing AS (
    SELECT m.render_id, count(*)::int AS pins, min(m.minted_at) AS first_minted_at
      FROM public.pinnacle_mint_events m
     WHERE m.render_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.pinnacle_catalog c WHERE c.render_id = m.render_id)
     GROUP BY m.render_id
  )
  SELECT jsonb_build_object(
    'missing_renders', (SELECT count(*) FROM missing),
    'missing_pins', (SELECT coalesce(sum(pins), 0) FROM missing),
    'missing_recent_renders', (SELECT count(*) FROM missing
                                WHERE first_minted_at > now() - make_interval(days => greatest(coalesce(p_recent_days, 14), 0))),
    'recent_days', greatest(coalesce(p_recent_days, 14), 0),
    'sample', coalesce((
      SELECT jsonb_agg(jsonb_build_object('render_id', s.render_id, 'pins', s.pins, 'first_minted_at', s.first_minted_at)
                       ORDER BY s.first_minted_at DESC, s.render_id)
        FROM (SELECT * FROM missing ORDER BY first_minted_at DESC, render_id
               LIMIT greatest(coalesce(p_sample, 10), 0)) s), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.pinnacle_minted_renders_missing_from_catalog(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pinnacle_minted_renders_missing_from_catalog(integer, integer) TO service_role;
