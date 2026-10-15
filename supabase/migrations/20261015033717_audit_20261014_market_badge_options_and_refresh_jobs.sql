-- audit_20261014_market_badge_options_and_refresh_jobs
--
-- get_market_badge_options(collection): every badge title in
-- market_edition_badges' latest run for that collection — the full Badge list
-- for the Market dropdown, from the same rows the v2 RPCs filter on (13 titles
-- each for Top Shot and All Day at first fill). A NEW function rather than a
-- `badges` key on get_market_filter_options, because replacing that one needs
-- CREATE OR REPLACE, which the MCP held this session. Read by
-- /api/market/filter-options (service_role).
--
-- Hourly refresh of the table, at the two emptiest minutes of the hour
-- (measured over active cron.job 2026-10-14): :21 Top Shot, :25 All Day. Each
-- run ~5 s; logged to pipeline_runs as `market-edition-badges`.
--
-- anon-exec: revoked (get_market_badge_options) — new fn; postgres/service_role only (verified has_function_privilege anon=false, authenticated=false).
--
-- REVERT: SELECT cron.unschedule('rpc-market-edition-badges-topshot');
--         SELECT cron.unschedule('rpc-market-edition-badges-allday');
--         DROP FUNCTION public.get_market_badge_options(uuid);
CREATE FUNCTION public.get_market_badge_options(p_collection_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(v ORDER BY v), '[]'::jsonb)
  FROM (
    SELECT DISTINCT mb.title v
    FROM public.market_edition_badges mb
    JOIN public.market_edition_badges_runs mr
      ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at
    WHERE mb.collection_id = p_collection_id
  ) s
$$;
REVOKE EXECUTE ON FUNCTION public.get_market_badge_options(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_badge_options(uuid) TO postgres, service_role;

SELECT cron.schedule('rpc-market-edition-badges-topshot', '21 * * * *',
  $$SELECT public.refresh_market_edition_badges('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid);$$);
SELECT cron.schedule('rpc-market-edition-badges-allday', '25 * * * *',
  $$SELECT public.refresh_market_edition_badges('dee28451-5d62-409e-a1ad-a83f763ac070'::uuid);$$);
