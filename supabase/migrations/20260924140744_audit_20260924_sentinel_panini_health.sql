-- audit_20260924_sentinel_panini_health
-- Input for the sentinel's new "Panini Ingest" arm (app/api/sentinel/route.ts). Panini had no
-- server-side alarm: the desktop panini-freshness-check never wrote a pipeline_runs row.
-- anon-exec: revoked (sentinel_panini_health) — REVOKE FROM PUBLIC, anon, authenticated below; verified has_function_privilege anon=false, authenticated=false.
-- Revert: DROP FUNCTION public.sentinel_panini_health();

CREATE FUNCTION public.sentinel_panini_health()
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'newest_walk_at',     (SELECT max(last_seen_at) FROM panini_editions),
    'edition_age_max_h',  (SELECT round((extract(epoch FROM now() - min(last_seen_at)) / 3600)::numeric, 1) FROM panini_editions),
    'editions',           (SELECT count(*) FROM panini_editions),
    'max_serials_per_edition_26h',
                          (SELECT COALESCE(max(n), 0) FROM (
                             SELECT count(*) AS n FROM panini_card_serials
                              WHERE captured_at > now() - interval '26 hours'
                              GROUP BY edition_external_id) z),
    'newest_sale_at',     (SELECT max(last_sale_at) FROM panini_card_serials)
  )
$$;

REVOKE ALL ON FUNCTION public.sentinel_panini_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sentinel_panini_health() TO service_role;

COMMENT ON FUNCTION public.sentinel_panini_health() IS
  'One jsonb row for the sentinel''s "Panini Ingest" arm (app/api/sentinel/route.ts). Replaces the retired '
  'desktop panini-freshness-check, which never wrote a pipeline_runs row. Reads OUTCOMES, not the run log: '
  'newest_walk_at (the residential runner walked something), edition_age_max_h (the stalest-first rotation is '
  'reaching the tail), max_serials_per_edition_26h (>30 = serial paging is live; 30 = regressed to one page), '
  'newest_sale_at (the nftSalesData feed is landing). ~60-70 ms warm.';
