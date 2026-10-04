-- audit_20261004_panini_products_bridge_reads_player_name_aliases
--
-- 2026-10-04 ~12:05 PM PT (Claude Code cloud; Trevor: "do it all"; register D26 / Megan DiLeo).
--
-- WHAT. sync_panini_products_bridge mints a players row per Panini player-name SPELLING
-- ('panini-' || slug(name)) and links editions by that slug. It never read player_name_aliases,
-- so one person with two names on Panini cards became two players and two /player/ pages:
-- "Megan DiLeo" (panini-megan-dileo, 5 editions, product 2420) and "Megan Gustafson"
-- (panini-megan-gustafson, 2 editions, product 2139, minted 10-04). A data-only merge would be
-- undone by the next :24 / :54 tick (the row re-inserted, the editions re-linked to it).
--
-- CHANGE (built from 20260929064132's body; live prosrc md5 67120da2… == that file, read 12:00 PM PT):
--   _pp_src gains alias_player = the player_name_aliases target for (panini, alias slug of the
--   name), using the alias table's documented slug expression; an aliased spelling is
--   (1) never inserted as a player, (2) never counted as a collision, (3) linked to the alias
--   target. Nothing else changes; with no Panini aliases registered the function behaves
--   exactly as before (alias_player is NULL on every row).
--
-- anon-exec: unchanged (sync_panini_products_bridge) — CREATE OR REPLACE of an existing fn with the same signature; ACL preserved, has_function_privilege('anon') = false read 12:00 PM PT; REVOKE/GRANT restated below as in 20260929064132.
--
-- APPLIED via the dashboard SQL editor in the same run as 20261004190000 / 20261004190200 (the gate
-- holds TRUNCATE-bearing bodies). No schema_migrations row.
--
-- ⚠ The body below is EXACTLY what is live (comment lines inside the body were stripped in the
-- editor run; prosrc md5 158d0bc1… re-read after apply). The three edits, for a reader:
--   _pp_src.alias_player ← player_name_aliases (panini, alias-table slug of the name);
--   step 2 inserts no player where alias_player IS NOT NULL; the collision set skips them;
--   step 3 links player_id = alias_player first.
--
-- REVERT: re-apply the CREATE OR REPLACE block of 20260929064132.

CREATE OR REPLACE FUNCTION public.sync_panini_products_bridge(p_lookback interval DEFAULT interval '6 hours')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  c_coll        constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  c_slug        constant text := 'panini_blockchain';
  MAX_AGE       constant interval := interval '45 days';
  v_started     timestamptz := clock_timestamp();
  v_since       timestamptz;
  v_products    integer := 0;
  v_src         integer := 0;
  v_stale       integer := 0;
  v_sets        integer := 0;
  v_players     integer := 0;
  v_collisions  integer := 0;
  v_eds         integer := 0;
  v_snaps       integer := 0;
  v_efc         integer := 0;
  v_ok          boolean := true;
  v_err         text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('sync_panini_products_bridge')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  v_since := CASE WHEN p_lookback IS NULL THEN '-infinity'::timestamptz ELSE now() - p_lookback END;
  BEGIN
    SELECT count(*)::int INTO v_products FROM public.panini_products WHERE walk_cards AND set_id <> 2332;
    CREATE TEMP TABLE IF NOT EXISTS _pp_src (
      external_id text PRIMARY KEY, product_set_id int, product_label text, player_name text, set_name text,
      tier tier_type, mint_cap int, thumbnail_url text, video_url text, first_minted_at timestamptz,
      set_ext text, player_ext text, alias_player uuid
    ) ON COMMIT DROP;
    TRUNCATE _pp_src;
    INSERT INTO _pp_src
    SELECT pe.external_id, pe.product_set_id,
           coalesce(nullif(btrim(pr.name), ''), 'Panini product ' || pr.set_id),
           btrim(pe.player_name), btrim(pe.set_name), pe.tier, pe.mint_cap, pe.thumbnail_url, pe.video_url, pe.first_minted_at,
           CASE WHEN nullif(btrim(coalesce(pe.set_name, '')), '') IS NOT NULL
                THEN 'panini-p' || pe.product_set_id || '-' || btrim(regexp_replace(lower(btrim(pe.set_name)), '[^a-z0-9]+', '-', 'g'), '-') END,
           CASE WHEN nullif(btrim(coalesce(pe.player_name, '')), '') IS NOT NULL AND btrim(pe.player_name) NOT LIKE '%|%'
                THEN 'panini-' || btrim(regexp_replace(lower(btrim(pe.player_name)), '[^a-z0-9]+', '-', 'g'), '-') END,
           (SELECT a.player_id FROM public.player_name_aliases a
             WHERE a.collection_id = c_coll
               AND a.alias_slug = regexp_replace(lower(btrim(extensions.unaccent(pe.player_name))), '[^a-z0-9]+', '-', 'g'))
      FROM public.panini_editions pe
      JOIN public.panini_products pr ON pr.set_id = pe.product_set_id
     WHERE pr.walk_cards AND pr.set_id <> 2332
       AND pe.last_seen_at > now() - MAX_AGE;
    GET DIAGNOSTICS v_src = ROW_COUNT;
    SELECT count(*)::int INTO v_stale
      FROM public.panini_editions pe JOIN public.panini_products pr ON pr.set_id = pe.product_set_id
     WHERE pr.walk_cards AND pr.set_id <> 2332
       AND (pe.last_seen_at IS NULL OR pe.last_seen_at <= now() - MAX_AGE);
    CREATE TEMP TABLE IF NOT EXISTS _pp_bad_player (player_ext text PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _pp_bad_player;
    INSERT INTO _pp_bad_player
    SELECT s.player_ext FROM _pp_src s WHERE s.player_ext IS NOT NULL AND s.alias_player IS NULL
     GROUP BY s.player_ext HAVING count(DISTINCT s.player_name) > 1
    UNION
    SELECT s.player_ext FROM _pp_src s JOIN public.players p ON p.external_id = s.player_ext
     WHERE s.alias_player IS NULL
       AND (p.collection_id IS DISTINCT FROM c_coll OR p.name IS DISTINCT FROM s.player_name);
    SELECT count(*)::int INTO v_collisions FROM _pp_bad_player;
    WITH s AS (
      SELECT DISTINCT ON (set_ext) set_ext, product_label || ' · ' || set_name AS nm
        FROM _pp_src WHERE set_ext IS NOT NULL
       ORDER BY set_ext, set_name
    )
    INSERT INTO public.sets (external_id, collection_id, name, created_at, updated_at)
    SELECT set_ext, c_coll, nm, now(), now() FROM s
    ON CONFLICT (external_id) DO UPDATE SET name = excluded.name, updated_at = now()
      WHERE sets.collection_id = c_coll AND sets.name IS DISTINCT FROM excluded.name;
    GET DIAGNOSTICS v_sets = ROW_COUNT;
    WITH p AS (
      SELECT DISTINCT ON (s.player_ext) s.player_ext, s.player_name
        FROM _pp_src s
       WHERE s.player_ext IS NOT NULL
         AND s.alias_player IS NULL
         AND NOT EXISTS (SELECT 1 FROM _pp_bad_player b WHERE b.player_ext = s.player_ext)
       ORDER BY s.player_ext
    )
    INSERT INTO public.players (external_id, collection_id, name, collection, created_at, updated_at)
    SELECT player_ext, c_coll, player_name, c_slug, now(), now() FROM p
    ON CONFLICT (external_id) DO NOTHING;
    GET DIAGNOSTICS v_players = ROW_COUNT;
    WITH src AS (
      SELECT s.*, st.id AS set_id,
             CASE WHEN s.alias_player IS NOT NULL THEN s.alias_player
                  WHEN s.player_ext IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _pp_bad_player b WHERE b.player_ext = s.player_ext)
                  THEN pl.id END AS player_id
        FROM _pp_src s
        LEFT JOIN public.sets st ON st.external_id = s.set_ext AND st.collection_id = c_coll
        LEFT JOIN public.players pl ON pl.external_id = s.player_ext AND pl.collection_id = c_coll
    )
    INSERT INTO public.editions (
      external_id, collection_id, name, player_id, set_id, tier, circulation_count,
      thumbnail_url, video_url, first_minted_at, collection, player_name, set_name,
      team_name, created_at, updated_at
    )
    SELECT src.external_id, c_coll,
           concat_ws(' - ', nullif(src.player_name, ''), nullif(src.set_name, '')),
           src.player_id, src.set_id, src.tier, src.mint_cap,
           public.panini_asset_url(src.thumbnail_url), public.panini_asset_url(src.video_url),
           src.first_minted_at, c_slug, src.player_name, src.set_name,
           NULL::text, now(), now()
      FROM src
      LEFT JOIN public.editions e ON e.collection_id = c_coll AND e.external_id = src.external_id
     WHERE e.id IS NULL
        OR (e.tier, e.circulation_count, e.player_name, e.set_name, e.set_id)
           IS DISTINCT FROM (src.tier, src.mint_cap, src.player_name, src.set_name, src.set_id)
        OR (src.player_id IS NOT NULL AND e.player_id IS DISTINCT FROM src.player_id)
    ON CONFLICT (external_id, collection_id) DO UPDATE SET
      name              = excluded.name,
      player_id         = coalesce(excluded.player_id, editions.player_id),
      set_id            = coalesce(excluded.set_id, editions.set_id),
      tier              = excluded.tier,
      circulation_count = excluded.circulation_count,
      thumbnail_url     = coalesce(excluded.thumbnail_url, editions.thumbnail_url),
      video_url         = coalesce(excluded.video_url, editions.video_url),
      player_name       = excluded.player_name,
      set_name          = excluded.set_name,
      updated_at        = now();
    GET DIAGNOSTICS v_eds = ROW_COUNT;
    CREATE TEMP TABLE IF NOT EXISTS _pp_touched (edition_id uuid PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _pp_touched;
    WITH ins AS (
      INSERT INTO public.fmv_snapshots
        (edition_id, collection_id, collection, fmv_usd, confidence, algo_version, computed_at)
      SELECT e.id, c_coll, c_slug, ps.fmv_usd, ps.confidence, ps.algo_version, ps.computed_at
        FROM public.panini_fmv_snapshots ps
        JOIN public.panini_editions pe ON pe.id = ps.edition_id
        JOIN _pp_src s ON s.external_id = pe.external_id
        JOIN public.editions e ON e.collection_id = c_coll AND e.external_id = pe.external_id
       WHERE ps.computed_at > v_since
         AND NOT EXISTS (
               SELECT 1 FROM public.fmv_snapshots f
                WHERE f.collection_id = c_coll
                  AND f.edition_id    = e.id
                  AND f.computed_at   = ps.computed_at
                  AND f.algo_version  = ps.algo_version)
      RETURNING edition_id
    ),
    t AS (
      INSERT INTO _pp_touched SELECT DISTINCT edition_id FROM ins
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM ins) INTO v_snaps;
    WITH latest AS MATERIALIZED (
      SELECT tt.edition_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
        FROM _pp_touched tt
        CROSS JOIN LATERAL (
          SELECT f.fmv_usd, f.floor_price_usd, f.confidence, f.computed_at
            FROM public.fmv_snapshots f
           WHERE f.edition_id = tt.edition_id
           ORDER BY f.computed_at DESC
           LIMIT 1) s
    ),
    up AS (
      INSERT INTO public.edition_fmv_current AS t
        (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
      SELECT l.edition_id, c_coll, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, now()
        FROM latest l
      ON CONFLICT (edition_id) DO UPDATE SET
        collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
        floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
        computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at
      WHERE EXCLUDED.computed_at >= t.computed_at
      RETURNING 1
    )
    SELECT count(*)::int INTO v_efc FROM up;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
    v_sets := NULL; v_players := NULL; v_eds := NULL; v_snaps := NULL; v_efc := NULL;
  END;
  PERFORM public.log_pipeline_run('panini-products-bridge', v_started, v_src, v_snaps, NULL, v_ok, v_err,
                                  c_slug, NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'lookback', COALESCE(p_lookback::text, 'full'),
                                                     'products_admitted', v_products,
                                                     'editions_fresh', v_src,
                                                     'stale_skipped', v_stale,
                                                     'sets_written', v_sets,
                                                     'players_inserted', v_players,
                                                     'player_slug_collisions', v_collisions,
                                                     'editions_written', v_eds,
                                                     'snapshots_written', v_snaps,
                                                     'efc_written', v_efc));
  RETURN jsonb_build_object('ok', v_ok, 'error', v_err, 'products_admitted', v_products, 'editions_fresh', v_src,
                            'stale_skipped', v_stale, 'sets_written', v_sets, 'players_inserted', v_players,
                            'player_slug_collisions', v_collisions, 'editions_written', v_eds,
                            'snapshots_written', v_snaps, 'efc_written', v_efc);
END
$function$;

REVOKE ALL ON FUNCTION public.sync_panini_products_bridge(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_panini_products_bridge(interval) TO service_role, cron_heavy;
