-- 2026-10-02 (PT) — get_pack_ev_contributors reads each pool edition's latest
-- FMV snapshot by index probe instead of DISTINCT ON over its whole history.
--
-- WHY. The pack-dist page ("What drives the remaining EV") calls this per
-- render: 61,617 calls since 2026-08-12, mean 922 ms (pg_stat_statements,
-- pooled across the Small -> Large change, so not current cost). Measured
-- 2026-10-02 ~8:15 PM PT on the largest pool (dist 4184, 1,531 editions):
-- old body warm 303 ms, 23,387 buffers + 1,081 temp blocks written (cold run
-- 1,484 ms); new body 42.8 ms, 14,995 buffers, no temp. Median pool is 2
-- editions (old: 13 ms), p90 82 (old: 32 ms) -- the gain is in the big pools.
--
-- EQUIVALENCE (measured, not argued): old function vs this body over 40 dists
-- (15 largest pools + 25 by md5 order), 351 rows each, EXCEPT both ways = 0;
-- the same instrument returns 1 for a 12-vs-11-row control.
--
-- WHAT: the `lf` DISTINCT ON CTE becomes a LEFT JOIN LATERAL ... ORDER BY
-- computed_at DESC LIMIT 1 on (collection_id, edition_id), served by
-- idx_fmv_snapshots_collection_edition. Same signature, return type, SECDEF,
-- search_path, volatility; output columns and ordering unchanged.
-- anon-exec: unchanged (get_pack_ev_contributors) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false, service_role=true.
--
-- Revert: the original body was applied fileless (audit_20260630_get_pack_ev_contributors);
-- restore it by putting back, in place of the LATERAL join,
--   lf AS (SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd,
--          fs.confidence::text AS confidence FROM public.fmv_snapshots fs
--          WHERE fs.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
--            AND fs.edition_id IN (SELECT edition_id FROM pool)
--          ORDER BY fs.edition_id, fs.computed_at DESC)
-- and `LEFT JOIN lf ON lf.edition_id = p.edition_id` in j; repoint the pin.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_pack_ev_contributors(text,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '3b35d53a163cbd6975431271cb789eb7' THEN
    RAISE EXCEPTION 'get_pack_ev_contributors changed since the measured base (live md5 %) -- re-derive', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_pack_ev_contributors(p_dist_id text, p_limit integer DEFAULT 12)
 RETURNS TABLE(edition_id uuid, external_id text, name text, player_name text, set_name text, tier text, circulation_count integer, fmv_usd numeric, confidence text, pull_prob numeric, ev_per_slot numeric, pct_of_ev numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pool AS (
    SELECT dp.edition_id, dp.drop_weight
    FROM public.pack_drop_pool dp
    WHERE dp.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND dp.dist_id = p_dist_id AND dp.drop_weight > 0
  ),
  -- 2026-10-02: each pool edition's latest snapshot by a per-edition index
  -- probe (collection_id, edition_id, computed_at DESC), not a DISTINCT ON
  -- over every snapshot of every pool edition (which sorted to temp files).
  j AS (
    SELECT p.edition_id, p.drop_weight, e.external_id, e.name, e.player_name, e.set_name,
           e.tier::text AS tier, e.circulation_count, lf.fmv_usd, lf.confidence
    FROM pool p JOIN public.editions e ON e.id = p.edition_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence::text AS confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
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
