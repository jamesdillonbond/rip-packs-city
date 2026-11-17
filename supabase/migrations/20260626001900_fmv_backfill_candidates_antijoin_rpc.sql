-- Record-only parity copy of the live migration
-- audit_20260625_fmv_backfill_candidates_antijoin_rpc (applied via MCP).
-- Do NOT re-run against prod; prod already has this function.
--
-- Replaces the /api/fmv-backfill route's full-table pagination of fmv_snapshots +
-- sales (~570 PostgREST round-trips / ~570k rows into Node Sets, which hung ~18min
-- under DB load even with an empty backlog) with a single indexed anti-join:
-- editions that have a price>0 sale but no fmv_snapshots row, limited. Identical
-- candidate set; FMV math in the route is unchanged. Measured ~2.5s on a calm DB.
-- Function-local statement_timeout overrides the 8s authenticator default that
-- route DB calls inherit.
--
-- Revert: DROP FUNCTION public.fmv_backfill_candidates(integer);

CREATE OR REPLACE FUNCTION public.fmv_backfill_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(ed_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '60s'
AS $$
  SELECT s.edition_id
  FROM public.sales s
  WHERE s.price_usd > 0
    AND s.edition_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.fmv_snapshots f WHERE f.edition_id = s.edition_id
    )
  GROUP BY s.edition_id
  LIMIT GREATEST(1, LEAST(p_limit, 500));
$$;

REVOKE ALL ON FUNCTION public.fmv_backfill_candidates(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fmv_backfill_candidates(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fmv_backfill_candidates(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_backfill_candidates(integer) TO service_role;
