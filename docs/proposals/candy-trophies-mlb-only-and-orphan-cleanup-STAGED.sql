-- audit_20261109_candy_trophies_mlb_only_and_orphan_one_of_one_cleanup
--
-- 2026-11-09 ~8:15 PM PT, Claude Code cloud (Trevor: "Keep going and do it all"; trophies scope:
-- "Baseball cards only"). Follows c30913392 ("candy: a 1-of-1 card is its own edition") and the
-- other session's 20261110034117 (a circulation-1 edition held twice is not a 1-of-1).
--
-- (1) v_insights_trophies: Candy rows only from MLB collections. An edition's collection is its key
--     prefix (`c:<slug>` or a registry prefix such as `asg26`; the Base Series has none and is MLB),
--     matched to candy_collections.edition_prefix where kind <> 'mlb'. Dry run on the live data
--     (8:10 PM PT): 7,372 -> 6,932 rows (the 440 that leave are all Candy `other`: Bat Cowl, Palm
--     Garden, DC ...), 256 ms warm / 88 k buffers (vs 92.7 k before, since the held probe now skips
--     them). Body = 20261110034117's plus one predicate in `cand`; security_invoker re-set.
-- (2) candy_delete_orphan_one_of_one_editions(p_limit): deletes Candy circulation-1 editions no card
--     holds, older than a day, not referenced by any CASCADE / SET NULL table; a NO ACTION
--     reference raises 23503, is caught and counted. pg_cron hourly at :22 (one other job there).
--     Measured 8:00 PM PT: 0 of 4,406 Candy 1/1 editions had FMV, sales or wishlist rows.
--
-- PIN: supabase/tests/candy_delete_orphan_one_of_one_editions.sql (function verbatim).
-- anon-exec: revoked (candy_delete_orphan_one_of_one_editions) — REVOKE FROM PUBLIC, anon, authenticated below; pg_cron runs as the owner.
-- REVERT: (1) re-apply the view from 20261110034117_audit_20261109_trophies_view_held_twice_is_not_one_of_one.sql;
--         (2) SELECT cron.unschedule('rpc-candy-orphan-one-of-one-editions');
--             DROP FUNCTION public.candy_delete_orphan_one_of_one_editions(integer);
--         (deleted editions were unheld and unreferenced; the census re-inserts any edition it meets again)

CREATE OR REPLACE VIEW public.v_insights_trophies
WITH (security_invoker = on) AS
 WITH ult AS (
   SELECT DISTINCT editions.collection_id FROM editions WHERE editions.tier = 'ULTIMATE'::tier_type
 ),
 cand AS MATERIALIZED (
   SELECT e.*,
     (e.tier = 'ULTIMATE'::tier_type
       OR (e.tier = 'LEGENDARY'::tier_type AND e.collection_id NOT IN (SELECT ult.collection_id FROM ult))) AS top_tier
   FROM editions e
   WHERE (e.circulation_count = 1
       OR e.tier = 'ULTIMATE'::tier_type
       OR (e.tier = 'LEGENDARY'::tier_type AND e.collection_id NOT IN (SELECT ult.collection_id FROM ult)))
     AND e.thumbnail_url IS NOT NULL
     -- 2026-11-09 (Trevor: "Baseball cards only"): Candy rows come only from MLB collections
     -- (candy_collections.kind = 'mlb'); an edition's collection is its key prefix. The Base
     -- Series (no prefix) is MLB. Keeps DC / Bat Cowl / Palm Garden off the board.
     AND NOT (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
              AND (CASE WHEN e.external_id::text LIKE 'c:%' THEN 'c:' || split_part(e.external_id::text, ':', 2)
                        ELSE split_part(e.external_id::text, ':', 1) END)
                  IN (SELECT cc.edition_prefix FROM candy_collections cc
                       WHERE cc.kind IS DISTINCT FROM 'mlb' AND cc.edition_prefix IS NOT NULL))
 ),
 held AS MATERIALIZED (
   SELECT c.*, (c.circulation_count = 1 AND h.n < 2) AS one_of_one
   FROM cand c
   LEFT JOIN LATERAL (
     SELECT count(*) AS n
     FROM (
       SELECT DISTINCT w.moment_id
       FROM wallet_moments_cache w
       WHERE c.circulation_count = 1
         AND w.collection_id = c.collection_id
         AND w.edition_key = c.external_id
       LIMIT 2
     ) x
   ) h ON true
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

CREATE OR REPLACE FUNCTION public.candy_delete_orphan_one_of_one_editions(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_candy      constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_candidates int := 0;
  v_deleted    int := 0;
  v_referenced int := 0;
  r            record;
BEGIN
  -- A Candy 1-of-1 edition no card holds any more. Since 2026-11-09 a 1/1 card is keyed by its
  -- own asset id (lib/chains/solana/normalize.ts), so the census re-keys and repoints every
  -- card off its old name-keyed edition; those old editions (merged Tricons, the one-row Bat
  -- Cowl / Palm Garden editions, the previous key of each genuine 1/1) are left with no holder.
  -- Only rows older than a day: a census page inserts an edition just before its holdings.
  -- Editions referenced by a CASCADE / SET NULL table are skipped outright (a delete would
  -- silently remove a user's wishlist or watchlist row); a NO ACTION reference raises and is
  -- counted, never forced.
  FOR r IN
    SELECT e.id
      FROM public.editions e
     WHERE e.collection_id = v_candy
       AND e.circulation_count = 1
       AND e.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                        WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id)
       AND NOT EXISTS (SELECT 1 FROM public.user_wishlists x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.watchlist_items x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_offers x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.pack_drop_pool x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_holders x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_lookup_failures x WHERE x.edition_id = e.id)
     ORDER BY e.created_at, e.id
     LIMIT GREATEST(coalesce(p_limit, 500), 0)
  LOOP
    v_candidates := v_candidates + 1;
    BEGIN
      DELETE FROM public.editions WHERE id = r.id;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      v_referenced := v_referenced + 1;
    END;
  END LOOP;

  -- rows_written = rows actually deleted; a referenced row is reported, not hidden.
  PERFORM public.log_pipeline_run(
    'candy-orphan-one-of-one-editions', v_started,
    v_candidates, v_deleted, v_referenced,
    true, NULL, 'candy_mlb', NULL, NULL,
    jsonb_build_object('candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced, 'limit', p_limit));
  RETURN jsonb_build_object('ok', true, 'candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.candy_delete_orphan_one_of_one_editions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_delete_orphan_one_of_one_editions(integer) TO service_role;

SELECT cron.schedule('rpc-candy-orphan-one-of-one-editions', '22 * * * *',
  'SELECT public.candy_delete_orphan_one_of_one_editions(500)');
