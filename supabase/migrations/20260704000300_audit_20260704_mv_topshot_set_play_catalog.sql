-- Bug 6 (perf): get_topshot_set_progress / _detail took 47-114s (>service_role 30s cap)
-- -> /api/sets 500. Most of the work is wallet-INDEPENDENT and recomputed every call:
-- the `universe` (one edition per set:play over ~24k editions), `edition_fmv` (latest
-- FMV via DISTINCT ON over ~434k TS fmv_snapshots — 18-41s even index-only, due to
-- append-table heap fetches), and per-set metadata. Precompute that scaffold once here
-- (matview), refreshed every 3h by pg_cron. Values identical to the prior inline CTEs.
CREATE MATERIALIZED VIEW public.mv_topshot_set_play_catalog AS
WITH universe AS (
  SELECT DISTINCT ON (e.set_id_onchain, e.play_id_onchain)
    e.id AS edition_id, e.external_id, e.set_id_onchain, e.play_id_onchain,
    e.player_name, e.tier::text AS tier, e.thumbnail_url
  FROM editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND e.play_id_onchain IS NOT NULL AND e.set_id_onchain IS NOT NULL
  ORDER BY e.set_id_onchain, e.play_id_onchain,
    (CASE WHEN e.external_id ~ '^[0-9]+:[0-9]+$' THEN 0 ELSE 1 END), e.created_at ASC
),
edition_fmv AS (
  SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
  FROM fmv_snapshots
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND fmv_usd IS NOT NULL
  ORDER BY edition_id, computed_at DESC
)
SELECT
  s.id AS set_id, s.set_id_onchain, s.name AS set_name, s.series, s.tier::text AS set_tier,
  u.play_id_onchain, u.edition_id, u.external_id, u.player_name, u.tier, u.thumbnail_url,
  ef.fmv_usd
FROM universe u
JOIN sets s ON s.set_id_onchain = u.set_id_onchain
  AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  AND s.set_id_onchain IS NOT NULL
LEFT JOIN edition_fmv ef ON ef.edition_id = u.edition_id
WITH DATA;

CREATE UNIQUE INDEX mv_ts_set_play_catalog_uidx
  ON public.mv_topshot_set_play_catalog (set_id, play_id_onchain);
CREATE INDEX mv_ts_set_play_catalog_setonchain_idx
  ON public.mv_topshot_set_play_catalog (set_id_onchain, play_id_onchain);

REVOKE ALL ON public.mv_topshot_set_play_catalog FROM PUBLIC;
GRANT SELECT ON public.mv_topshot_set_play_catalog TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_topshot_set_play_catalog()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  SET statement_timeout TO '180s'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_set_play_catalog;
END;
$function$;
REVOKE ALL ON FUNCTION public.refresh_mv_topshot_set_play_catalog() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_mv_topshot_set_play_catalog() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_mv_topshot_set_play_catalog() TO service_role;

SELECT cron.schedule('rpc-refresh-mv-ts-set-play-catalog', '17 */3 * * *', $$SELECT public.refresh_mv_topshot_set_play_catalog();$$);
