-- audit_20261019: "What drives the remaining EV" for every collection with a drop pool
--
-- WHY. The pack-dist page's EV-contributor list ("What drives the remaining EV") was
-- Top Shot only: get_pack_ev_contributors hardcoded the Top Shot collection_id in both
-- the pool read and the FMV probe, and the page gated on the slug. All Day and Golazos
-- carry the same `pack_drop_pool` shape, and fresher than Top Shot's: measured 2026-10-19
-- ~7:25 PM PT, All Day 2,883 of 3,147 pool dists refreshed in the last 2 days (median age
-- 0.8 d), Golazos 209 of 211 (0.6 d), Top Shot 64 of 2,121 (52.7 d). Weights are remaining
-- counts (not uniform placeholders: All Day 120 of 3,147 multi-edition dists have one
-- weight; Golazos 8 of 211).
--
-- WHAT. A 3-arg overload (p_dist_id, p_limit, p_collection_id — NO defaults, so no call
-- can resolve ambiguously against the 2-arg form) carries the body, with both collection
-- filters reading p_collection_id; otherwise verbatim from 20261003031302 (the per-edition
-- latest-FMV index probe). The existing 2-arg (p_dist_id, p_limit DEFAULT 12) form keeps
-- its signature, grants and Top Shot meaning, and becomes a wrapper that passes the Top
-- Shot id. No DROP: the MCP apply path hangs on a destructive statement (it waits on a
-- confirmation), and nothing here needs one.
--
-- REVERT: re-apply supabase/migrations/20261003031302_audit_20261002_pack_ev_contributors_latest_fmv_by_index_probe.sql
-- (restores the 2-arg body), then DROP FUNCTION public.get_pack_ev_contributors(text, integer, uuid);
--
-- anon-exec: no (get_pack_ev_contributors) — the new 3-arg form has EXECUTE revoked from PUBLIC, anon and authenticated and granted to service_role only, like the 2-arg form (unchanged: CREATE OR REPLACE, same signature, ACL preserved; the pack page reads it through the service-role client).

CREATE OR REPLACE FUNCTION public.get_pack_ev_contributors(p_dist_id text, p_limit integer, p_collection_id uuid)
 RETURNS TABLE(edition_id uuid, external_id text, name text, player_name text, set_name text, tier text, circulation_count integer, fmv_usd numeric, confidence text, pull_prob numeric, ev_per_slot numeric, pct_of_ev numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pool AS (
    SELECT dp.edition_id, dp.drop_weight
    FROM public.pack_drop_pool dp
    WHERE dp.collection_id = p_collection_id
      AND dp.dist_id = p_dist_id AND dp.drop_weight > 0
  ),
  -- 2026-10-02: each pool edition's latest snapshot by a per-edition index
  -- probe (collection_id, edition_id, computed_at DESC), not a DISTINCT ON
  -- over every snapshot of every pool edition (which sorted to temp files).
  -- 2026-10-19: the collection is a parameter (the 2-arg form passes Top Shot).
  j AS (
    SELECT p.edition_id, p.drop_weight, e.external_id, e.name, e.player_name, e.set_name,
           e.tier::text AS tier, e.circulation_count, lf.fmv_usd, lf.confidence
    FROM pool p JOIN public.editions e ON e.id = p.edition_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence::text AS confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = p_collection_id
        AND fs.edition_id = p.edition_id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
  ),
  tot AS ( SELECT sum(drop_weight) AS sw, sum(drop_weight*coalesce(fmv_usd,0)) AS swf FROM j )
  SELECT j.edition_id, j.external_id, j.name, j.player_name, j.set_name, j.tier,
    j.circulation_count, round(j.fmv_usd,2) AS fmv_usd, j.confidence,
    round((j.drop_weight/nullif(t.sw,0))::numeric,5) AS pull_prob,
    round((j.drop_weight/nullif(t.sw,0)*coalesce(j.fmv_usd,0))::numeric,2) AS ev_per_slot,
    round((j.drop_weight*coalesce(j.fmv_usd,0)/nullif(t.swf,0)*100)::numeric,1) AS pct_of_ev
  FROM j CROSS JOIN tot t
  ORDER BY j.drop_weight*coalesce(j.fmv_usd,0) DESC
  LIMIT p_limit;
$function$;

REVOKE ALL ON FUNCTION public.get_pack_ev_contributors(text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pack_ev_contributors(text, integer, uuid) TO service_role;

-- The 2-arg form: Top Shot, as since 2026-10-02.
CREATE OR REPLACE FUNCTION public.get_pack_ev_contributors(p_dist_id text, p_limit integer DEFAULT 12)
 RETURNS TABLE(edition_id uuid, external_id text, name text, player_name text, set_name text, tier text, circulation_count integer, fmv_usd numeric, confidence text, pull_prob numeric, ev_per_slot numeric, pct_of_ev numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT * FROM public.get_pack_ev_contributors(p_dist_id, p_limit, '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid);
$function$;
