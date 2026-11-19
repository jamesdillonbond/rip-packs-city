-- audit_20261119_trophies_board_filters_collections_before_the_wallet_probe
--
-- 2026-11-19 (PT, ~12:15 AM; Claude Code cloud; Trevor: "Keep going") -- inbox 2026-11-19T0200Z item 2,
-- queued by the 11-19 overnight pass as a public read-path change.
--
-- WHY. /insights/trophies and /api/public/insights/trophies (lib/insights/trophies-board.ts) read
-- v_insights_trophies filtered by collection. The filter is applied OUTSIDE the view's MATERIALIZED `cand`
-- and `held` CTEs (fences kept on purpose: 20261110034117 measured the un-fenced plan at 523k buffers /
-- 6.8 s), so the `held` one-of-one wallet probe runs over EVERY candidate -- Candy and Panini included --
-- and discards them afterwards. Measured 11-19 ~12:05 AM PT, the default board (4 published edition
-- collections, FMV desc, limit 200): 8,127 candidates probed, 1,209 kept; 57,076 buffers (4,786 read),
-- 2.58 s; the probe alone 34,753 buffers. Vercel logged "[insights/trophies] read exceeded 8000ms".
--
-- WHAT. get_insights_trophies(p_collections text[]) = the view's logic (live viewdef md5
-- 78086388b3614b597fe5b1e05078122b) with ONE added predicate inside `cand`: e_1.collection = ANY (p_collections),
-- and the two MATERIALIZED CTEs carrying only the 15 columns the final SELECT reads (the view materializes
-- ~38). Same rows for the same collections by construction (every later step is per-candidate) -- and
-- proven on prod before the board was switched (EXCEPT both ways, every collection). Returns the view's own
-- row type, so a column can never drift between the two. The view stays (other readers).
-- SECURITY INVOKER, like the view (security_invoker=on): RLS applies exactly as before.
-- anon-exec: granted (get_insights_trophies) -- a public insights board read; the view is anon-SELECTable today.
--
-- REVERT: point lib/insights/trophies-board.ts back at .from("v_insights_trophies"); then
--   DROP FUNCTION public.get_insights_trophies(text[]);

CREATE OR REPLACE FUNCTION public.get_insights_trophies(p_collections text[])
RETURNS SETOF public.v_insights_trophies
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $function$
 WITH ult AS (
         SELECT DISTINCT editions.collection_id
           FROM editions
          WHERE editions.tier = 'ULTIMATE'::tier_type
        ), cand AS MATERIALIZED (
         SELECT e_1.id,
            e_1.external_id,
            e_1.collection_id,
            e_1.name,
            e_1.tier,
            e_1.series,
            e_1.circulation_count,
            e_1.thumbnail_url,
            e_1.video_url,
            e_1.collection,
            e_1.player_name,
            e_1.set_name,
            e_1.team_name,
            e_1.tier = 'ULTIMATE'::tier_type OR e_1.tier = 'LEGENDARY'::tier_type AND NOT (e_1.collection_id IN ( SELECT ult.collection_id
                   FROM ult)) AS top_tier
           FROM editions e_1
          WHERE e_1.collection = ANY (p_collections)
            AND (e_1.circulation_count = 1 OR e_1.tier = 'ULTIMATE'::tier_type OR e_1.tier = 'LEGENDARY'::tier_type AND NOT (e_1.collection_id IN ( SELECT ult.collection_id
                   FROM ult))) AND e_1.thumbnail_url IS NOT NULL AND NOT (e_1.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND (
                CASE
                    WHEN e_1.external_id::text ~~ 'c:%'::text THEN 'c:'::text || split_part(e_1.external_id::text, ':'::text, 2)
                    ELSE split_part(e_1.external_id::text, ':'::text, 1)
                END IN ( SELECT cc.edition_prefix
                   FROM candy_collections cc
                  WHERE cc.kind IS DISTINCT FROM 'mlb'::text AND cc.edition_prefix IS NOT NULL)))
        ), held AS MATERIALIZED (
         SELECT c.id,
            c.external_id,
            c.collection_id,
            c.name,
            c.tier,
            c.series,
            c.circulation_count,
            c.thumbnail_url,
            c.video_url,
            c.collection,
            c.player_name,
            c.set_name,
            c.team_name,
            c.top_tier,
            c.circulation_count = 1 AND h.n < 2 AS one_of_one
           FROM cand c
             LEFT JOIN LATERAL ( SELECT count(*) AS n
                   FROM ( SELECT DISTINCT w.moment_id
                           FROM wallet_moments_cache w
                          WHERE c.circulation_count = 1 AND w.collection_id = c.collection_id AND w.edition_key = c.external_id::text
                         LIMIT 2) x) h ON true
        )
 SELECT e.id AS edition_id,
    e.external_id,
    e.collection,
    e.collection_id,
    e.name,
    e.player_name,
    e.set_name,
    e.team_name,
    e.tier::text AS tier,
    e.series,
    e.circulation_count,
    e.thumbnail_url,
    e.video_url,
    e.one_of_one AS is_one_of_one,
    e.tier = 'ULTIMATE'::tier_type AS is_ultimate,
    f.fmv_usd,
    f.confidence,
    f.computed_at AS fmv_computed_at,
    e.top_tier AS is_top_tier
   FROM held e
     LEFT JOIN LATERAL ( SELECT fs.fmv_usd,
            fs.confidence,
            fs.computed_at
           FROM fmv_snapshots fs
          WHERE fs.edition_id = e.id
          ORDER BY fs.computed_at DESC
         LIMIT 1) f ON true
  WHERE e.one_of_one OR e.top_tier;
$function$;

REVOKE ALL ON FUNCTION public.get_insights_trophies(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_insights_trophies(text[]) TO anon, authenticated, service_role;
