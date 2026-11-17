-- Roadmap headline metric — share of prices at HIGH/MEDIUM confidence, per
-- collection (roadmap-2026-08-03 §: "the headline metric is the share of prices
-- at HIGH/MEDIUM confidence"). It had NO cheap read path: computing it live is a
-- DISTINCT-ON latest-per-edition scan over ~680k Top Shot fmv_snapshots (~15-18s
-- warm, >60s cold), which blows the service_role 30s / MCP 60s budget, so nobody
-- could measure the one number the accuracy thesis turns on without an ad-hoc
-- query that times out.
--
-- This SECDEF fn makes it reliably measurable on demand: one scan, function-local
-- statement_timeout=120s, service_role-only. Canonical-edition scoping mirrors
-- rpc_trust_health_precompute_refresh legs 2-5 EXACTLY (Top Shot counts only
-- external_ids of the form 'setID:playID[::parallel]', excluding the UUID-keyed
-- dupe residue that ts_uuid_dupes_created_24h already watches), so the share is
-- measured over the same real-edition population as the stale-% metric and is
-- directly comparable to the roadmap's figures. Confidence enum is UPPERCASE.
CREATE OR REPLACE FUNCTION public.rpc_fmv_confidence_share()
RETURNS TABLE(
  collection_id uuid,
  priced_editions bigint,
  high bigint,
  medium bigint,
  high_med bigint,
  high_med_pct numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET statement_timeout TO '120s'
SET search_path TO 'public'
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
           fs.collection_id, fs.edition_id, fs.confidence
    FROM fmv_snapshots fs
    ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
  ),
  elig AS (
    SELECT l.collection_id, l.confidence
    FROM latest l
    LEFT JOIN editions e ON e.id = l.edition_id
    WHERE l.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       OR e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  )
  SELECT
    elig.collection_id,
    count(*) AS priced_editions,
    count(*) FILTER (WHERE elig.confidence = 'HIGH') AS high,
    count(*) FILTER (WHERE elig.confidence = 'MEDIUM') AS medium,
    count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM')) AS high_med,
    round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM'))
          / NULLIF(count(*), 0)::numeric, 1) AS high_med_pct
  FROM elig
  GROUP BY elig.collection_id
$function$;

REVOKE ALL ON FUNCTION public.rpc_fmv_confidence_share() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_fmv_confidence_share() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_fmv_confidence_share() TO service_role;

COMMENT ON FUNCTION public.rpc_fmv_confidence_share() IS
  'Roadmap headline metric: per-collection share of latest FMV snapshots at HIGH/MEDIUM confidence (canonical editions only, Top-Shot-scoped like the stale-% metric). SECDEF, service_role-only, 120s local timeout. The one cheap read path for a number that otherwise needs a ~15-18s timeout-prone scan.';
