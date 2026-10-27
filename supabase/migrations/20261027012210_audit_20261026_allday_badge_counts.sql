-- audit_20261026: All Day badge counts for the concierge (All Day ↔ Top Shot parity pass, 2026-10-26 evening PT).
--
-- get_badge_info told every reader "Moment tags (badges) are indexed for NBA Top Shot only" — false since
-- allday-badge-ingest writes All Day's badges into badge_editions.set_play_tags: 8 badges on 3,202 of 5,607 All Day
-- editions read 10-26 ~6:55 PM PT (ALL DAY Debut 1,367 · Rookie Year 1,158 · Rookie Mint 863 · Challenge Reward 564 ·
-- Championship Year 473 · Dynamic Moment 402 · Hall of Fame 245 · Crafted Reward 117). This function returns them with
-- per-tier counts, titles DERIVED from the data (a hardcoded title list beside a live table goes stale silently).
-- 20 ms / 1.6k buffers. Anon cannot execute (the concierge reads with the service role).
--
-- Revert: DROP FUNCTION public.get_allday_badge_counts();

-- anon-exec: revoked (get_allday_badge_counts) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_allday_badge_counts()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH x AS (
    SELECT t->>'id' AS id, t->>'title' AS title, b.tier
      FROM public.badge_editions b, jsonb_array_elements(b.set_play_tags) t
     WHERE b.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
       AND jsonb_typeof(b.set_play_tags) = 'array'
       AND t->>'title' IS NOT NULL
  ), per_tier AS (
    SELECT id, title, COALESCE(tier, 'UNKNOWN') AS tier, count(*)::int AS n FROM x GROUP BY 1, 2, 3
  )
  SELECT jsonb_build_object(
    'editions_indexed', (SELECT count(*) FROM public.badge_editions WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'),
    'badges', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', id, 'title', title, 'editions', n, 'by_tier', by_tier) ORDER BY n DESC, title)
        FROM (SELECT id, title, sum(n)::int AS n, jsonb_object_agg(tier, n) AS by_tier FROM per_tier GROUP BY 1, 2) s), '[]'::jsonb))
$function$;

REVOKE EXECUTE ON FUNCTION public.get_allday_badge_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_badge_counts() TO postgres, service_role;

COMMENT ON FUNCTION public.get_allday_badge_counts() IS
  'NFL All Day moment badges (badge_editions.set_play_tags, written by allday-badge-ingest) with edition counts per badge and per tier, titles derived from the data (never a hardcoded list). For the concierge get_badge_info All Day arm (Top Shot parity, 2026-10-26). audit_20261026.';
