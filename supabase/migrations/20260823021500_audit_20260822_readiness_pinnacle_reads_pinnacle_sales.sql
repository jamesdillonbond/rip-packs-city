-- audit_20260822_readiness_pinnacle_reads_pinnacle_sales
--
-- Follow-up to 20260823020000. Found by looking at the payload the new function
-- actually returned instead of assuming it was right — a defect I would
-- otherwise have inherited verbatim from `health_check()`.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- Disney Pinnacle sales do NOT live in `sales`. They live in `pinnacle_sales`.
-- MEASURED 2026-08-23 02:0xZ: `pinnacle_sales` holds **343 sales in the last
-- 24 h** (newest 01:26:55Z, 194,164 rows all-time) while `sales` holds **0
-- Pinnacle rows in the last 30 DAYS**. So a `sales_24h` read against `sales`
-- returns a measured, confident **0** for a collection trading 343 times a day.
--
-- That zero is not cosmetic. `/[collection]/market` and
-- `/[collection]/analytics` both branch on `sales_24h < 10` and render
-- "THIN-VOLUME ECOSYSTEM — analytics directional only", so every visitor to
-- /disney-pinnacle/market and /disney-pinnacle/analytics was told the market is
-- thin. It is the honesty class in its usual shape: a read of the WRONG TABLE
-- published as a fact about the world, with no way for the surface to tell the
-- difference.
--
-- ⚠ This was latent in `health_check()` before it — its `sales_24h` leg had no
-- Pinnacle branch even though the SAME expression special-cased Pinnacle for
-- `sales_total`, `editions` and `fmv_editions` three lines above. The caveat was
-- therefore wrong on Pinnacle for as long as /api/ready worked, and has only
-- been invisible since 2026-08-15 because the route 500s (deep-audit R44).
--
-- ⚠ UFC Strike's 0 is a DIFFERENT thing and is NOT fixed here, because it is
-- not wrong: `sales` holds 0 UFC rows in 30 days and UFC Strike has moved off
-- this chain. A genuine zero must still read as zero — that is the no-change
-- control for this fix, not a second bug.
--
-- Cost: `pinnacle_sales_sold_at_idx (sold_at DESC)` covers the 24 h window;
-- the branch is taken for exactly one of five collections.
--
-- Revert: re-apply the function body from 20260823020000 (the CASE collapses to
--         its ELSE arm).

CREATE OR REPLACE FUNCTION public.readiness_collection_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'slug', c.slug,
        'name', c.name,
        -- Pinnacle's sales are in their own table; reading `sales` here returns
        -- a confident 0 for a collection trading hundreds of times a day.
        'sales_24h',
          CASE WHEN c.slug = 'disney_pinnacle'
            THEN (SELECT count(*) FROM public.pinnacle_sales ps
                   WHERE ps.sold_at > now() - interval '24 hours')
            ELSE (SELECT count(*) FROM public.sales s
                   WHERE s.collection_id = c.id
                     AND s.sold_at > now() - interval '24 hours')
          END,
        'last_sale_at',
          CASE WHEN c.slug = 'disney_pinnacle'
            THEN (SELECT max(ps.sold_at) FROM public.pinnacle_sales ps
                   WHERE ps.sold_at > now() - interval '7 days')
            ELSE (SELECT max(s.sold_at) FROM public.sales s
                   WHERE s.collection_id = c.id
                     AND s.sold_at > now() - interval '7 days')
          END
      )
      ORDER BY c.slug
    ),
    '[]'::jsonb
  )
  FROM public.collections c
  WHERE c.is_active = true;
$$;

-- CREATE OR REPLACE FUNCTION preserves the ACL, but the grant is asserted again
-- rather than assumed — a replace that silently lost EXECUTE is exactly how
-- /api/ready broke in the first place.
REVOKE ALL ON FUNCTION public.readiness_collection_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_collection_stats() TO anon, authenticated, service_role;
