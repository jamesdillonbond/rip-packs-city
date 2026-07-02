-- P1a display guard for Market/Sniper: precomputed per-edition 90d sales max + thin flag.
-- De-fakes the -98/-99% "deals" where FMV overshoots the highest price the
-- edition ever sold for in 90d (450+ editions; 15 egregious >3x max). READ-SIDE
-- only: does NOT mutate fmv_snapshots. The stored-FMV root cause is P1b.
-- Keeps topshot_thin_fmv_editions (deals board + alerts) untouched.
-- Applied live via MCP apply_migration 2026-07-02; repo-sync record.
-- Read by lib/fmv-display-guard.ts → /api/market + /api/sniper-feed.
-- Revert: DROP TABLE public.topshot_fmv_display_guard CASCADE;
--         DROP FUNCTION public.refresh_topshot_fmv_display_guard();
--         SELECT cron.unschedule('rpc-refresh-fmv-display-guard');

CREATE TABLE IF NOT EXISTS public.topshot_fmv_display_guard (
  external_id     text PRIMARY KEY,
  edition_id      uuid NOT NULL,
  fmv_usd         numeric NOT NULL,
  max_sale_90d    numeric NOT NULL,
  median_90d      numeric,
  n_90d           integer NOT NULL,
  is_thin         boolean NOT NULL DEFAULT false,
  fmv_exceeds_max boolean NOT NULL DEFAULT false,
  computed_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.topshot_fmv_display_guard IS
  'P1a: per-edition 90d sales max + thin flag for Top Shot. Read by /api/market and /api/sniper-feed to clamp fake discounts (ask below an FMV that exceeds the edition''s own 90d max sale) and flag thin-data FMV. Refreshed daily by refresh_topshot_fmv_display_guard(). Display-only; does not touch fmv_snapshots.';

ALTER TABLE public.topshot_fmv_display_guard ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.refresh_topshot_fmv_display_guard()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.topshot_fmv_display_guard;

  INSERT INTO public.topshot_fmv_display_guard
    (external_id, edition_id, fmv_usd, max_sale_90d, median_90d, n_90d, is_thin, fmv_exceeds_max, computed_at)
  WITH s90 AS (
    SELECT s.edition_id,
           count(*)::integer AS n_90d,
           max(s.price_usd)::numeric AS max_sale_90d,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd))::numeric AS median_90d
    FROM public.sales s
    WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
    GROUP BY s.edition_id
  ),
  lf AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd::numeric AS fmv_usd
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND fs.computed_at > now() - interval '10 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  )
  SELECT e.external_id,
         e.id,
         lf.fmv_usd,
         s.max_sale_90d,
         s.median_90d,
         s.n_90d,
         (s.n_90d < 15 AND s.median_90d > 0 AND lf.fmv_usd > 1.5 * s.median_90d) AS is_thin,
         (lf.fmv_usd > s.max_sale_90d) AS fmv_exceeds_max,
         now()
  FROM public.editions e
  JOIN s90 s ON s.edition_id = e.id
  JOIN lf   ON lf.edition_id = e.id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND e.external_id ~ '^[0-9]+:[0-9]+$'
    AND lf.fmv_usd > 0
    AND (
      lf.fmv_usd > s.max_sale_90d
      OR (s.n_90d < 15 AND s.median_90d > 0 AND lf.fmv_usd > 1.5 * s.median_90d)
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_topshot_fmv_display_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_fmv_display_guard() TO service_role;

-- Daily refresh at 13:45Z, right after rpc-refresh-thin-fmv-guard (13:30Z) so it
-- reflects the same fresh FMV. (Applied live; recorded here for parity.)
-- SELECT cron.schedule('rpc-refresh-fmv-display-guard', '45 13 * * *',
--   $$SELECT public.refresh_topshot_fmv_display_guard();$$);
