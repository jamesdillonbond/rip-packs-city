-- audit_20260929_panini_products_bridge
--
-- The per-product pricing bridge (filed 2026-09-28 ~11:31 PM PT in
-- docs/strategy/panini-multi-product-2026-09-28.md, "The open item"; Trevor chose to build it here).
-- 29 non-WC products were admitted to the walk (panini_products.walk_cards) for a linked collector,
-- so their cards, serials, sales AND FMV snapshots now land in the panini_* plane — the ingest route
-- prices every admitted card with the same panini-1.1.0 engine. What they lacked is the bridge into
-- the SHARED catalogue (editions / sets / players / fmv_snapshots / edition_fmv_current), which is
-- how the trophy slab, the trophy picker, Panini player pages and the Market tab read a price.
-- sync_panini_bridge / sync_panini_editions_to_shared stay WC-only (panini_wc_editions) and are NOT
-- touched: their 1.0% staleness gate is a statement about WC and must keep meaning that.
--
-- This function bridges admitted NON-WC products (walk_cards AND set_id <> 2332):
--   · FRESHNESS, per edition rather than per product: an edition is bridged only if its row was
--     walked within 45 days. A stale edition is not refused as a run (the WC gate's all-or-nothing
--     shape would let one old product freeze every other one) — it is left out and COUNTED
--     (stale_skipped), and its already-bridged price simply stops advancing.
--   · SETS are namespaced per product: 'panini-p<setId>-<slug>'. Set names like "Base Prizms Silver"
--     recur across products; an un-namespaced slug would MERGE them (and with WC's). The display
--     name carries the product: "<panini_products.name> · <set>", or "Panini product <setId> · <set>"
--     until the product is named — the name upsert follows the registry when it is.
--   · PLAYERS share WC's 'panini-<slug>' namespace — one person across products is one person — but
--     this function never RENAMES an existing player and never links through an ambiguous slug:
--     a slug whose source spellings differ, or whose existing row carries a different name, is
--     skipped (player_slug_collisions) and its editions are bridged with player_id NULL.
--   · Dual-player cards ("A | B") get no player link, as on WC.
--   · FMV: the product's panini_fmv_snapshots in the lookback window, for bridged editions, into
--     fmv_snapshots (dedup on edition + computed_at + algo_version) and edition_fmv_current (never
--     backwards) — the same statements as sync_panini_bridge steps 2-3. The shared fmv_snapshots
--     triggers (phantom guard etc.) apply unchanged.
-- Logged as pipeline 'panini-products-bridge'. Scheduled :24/:54 (WC's runs at :14/:44).

-- anon-exec: revoked (sync_panini_products_bridge) — NEW function: REVOKE FROM PUBLIC, anon, authenticated in one statement below; GRANT to service_role + cron_heavy (the pg_cron caller), as sync_panini_bridge.
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
      set_ext text, player_ext text
    ) ON COMMIT DROP;
    TRUNCATE _pp_src;

    INSERT INTO _pp_src
    SELECT pe.external_id, pe.product_set_id,
           coalesce(nullif(btrim(pr.name), ''), 'Panini product ' || pr.set_id),
           btrim(pe.player_name), btrim(pe.set_name), pe.tier, pe.mint_cap, pe.thumbnail_url, pe.video_url, pe.first_minted_at,
           CASE WHEN nullif(btrim(coalesce(pe.set_name, '')), '') IS NOT NULL
                THEN 'panini-p' || pe.product_set_id || '-' || btrim(regexp_replace(lower(btrim(pe.set_name)), '[^a-z0-9]+', '-', 'g'), '-') END,
           CASE WHEN nullif(btrim(coalesce(pe.player_name, '')), '') IS NOT NULL AND btrim(pe.player_name) NOT LIKE '%|%'
                THEN 'panini-' || btrim(regexp_replace(lower(btrim(pe.player_name)), '[^a-z0-9]+', '-', 'g'), '-') END
      FROM public.panini_editions pe
      JOIN public.panini_products pr ON pr.set_id = pe.product_set_id
     WHERE pr.walk_cards AND pr.set_id <> 2332
       AND pe.last_seen_at > now() - MAX_AGE;
    GET DIAGNOSTICS v_src = ROW_COUNT;

    SELECT count(*)::int INTO v_stale
      FROM public.panini_editions pe JOIN public.panini_products pr ON pr.set_id = pe.product_set_id
     WHERE pr.walk_cards AND pr.set_id <> 2332
       AND (pe.last_seen_at IS NULL OR pe.last_seen_at <= now() - MAX_AGE);

    -- Player slugs that cannot be linked unambiguously: two spellings in the source, or an existing
    -- row (any product, WC included) under a different name.
    CREATE TEMP TABLE IF NOT EXISTS _pp_bad_player (player_ext text PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _pp_bad_player;
    INSERT INTO _pp_bad_player
    SELECT s.player_ext FROM _pp_src s WHERE s.player_ext IS NOT NULL
     GROUP BY s.player_ext HAVING count(DISTINCT s.player_name) > 1
    UNION
    SELECT s.player_ext FROM _pp_src s JOIN public.players p ON p.external_id = s.player_ext
     WHERE p.collection_id IS DISTINCT FROM c_coll OR p.name IS DISTINCT FROM s.player_name;
    SELECT count(*)::int INTO v_collisions FROM _pp_bad_player;

    -- 1. Sets, one per (product, set name slug); the name follows the registry's product name.
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

    -- 2. Players: insert-only, never through a skipped slug.
    WITH p AS (
      SELECT DISTINCT ON (s.player_ext) s.player_ext, s.player_name
        FROM _pp_src s
       WHERE s.player_ext IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM _pp_bad_player b WHERE b.player_ext = s.player_ext)
       ORDER BY s.player_ext
    )
    INSERT INTO public.players (external_id, collection_id, name, collection, created_at, updated_at)
    SELECT player_ext, c_coll, player_name, c_slug, now(), now() FROM p
    ON CONFLICT (external_id) DO NOTHING;
    GET DIAGNOSTICS v_players = ROW_COUNT;

    -- 3. Editions: only rows missing from the shared catalogue or drifted in a bridged field.
    WITH src AS (
      SELECT s.*, st.id AS set_id,
             CASE WHEN s.player_ext IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _pp_bad_player b WHERE b.player_ext = s.player_ext)
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

    -- 4. FMV snapshots in the window for these products' bridged editions.
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

    -- 5. edition_fmv_current from each touched edition's latest snapshot; never backwards.
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
    -- The block rolls back as a whole: nothing is known to be written.
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

COMMENT ON FUNCTION public.sync_panini_products_bridge(interval) IS
  'Bridges admitted NON-WC Panini products (panini_products.walk_cards, set_id <> 2332) into the shared editions / sets / players / fmv_snapshots / edition_fmv_current. Per-edition 45-day freshness filter (stale editions counted, not bridged); product-namespaced set slugs; never renames a player or links through an ambiguous slug. WC stays on sync_panini_bridge. Logs panini-products-bridge.';

-- REVERT: SELECT cron.unschedule('rpc-panini-products-bridge'); DROP FUNCTION public.sync_panini_products_bridge(interval);
--   (bridged rows stay: shared editions/fmv for collection d1a0a7f5… with external_id
--   NOT LIKE 'packcard-2332\_%', and sets matching external_id ~ '^panini-p[0-9]+-' — ⚠ NOT a bare
--   'panini-p%': four WC sets (panini-phenomenon-*, panini-prizmania) match that. Players inserted
--   here are indistinguishable from WC ones by id; delete only after reading their dependents).
-- VERIFIED 2026-09-28 ~11:45 PM PT (live md5 of prosrc = this file's body; anon/authenticated
--   EXECUTE false; cron_heavy true; job 24,54 as cron_heavy) and end-to-end in a ROLLED-BACK
--   transaction on 4 synthetic 1941 editions: 3 fresh bridged, 1 stale skipped; set
--   'panini-p1941-base-prizms-silver' named 'Panini product 1941 · Base Prizms Silver' while WC's
--   'panini-base-prizms-silver' kept its name; new player inserted and linked; an upper-cased WC
--   player name was a collision (not linked, WC name kept); the dual card got no player; FMV 42
--   MEDIUM reached edition_fmv_current; a second run wrote 0 (idempotent). Nothing persisted.
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-panini-products-bridge',
  '24,54 * * * *',
  'SELECT public.sync_panini_products_bridge();'
);
RESET ROLE;

DO $$
DECLARE v_sched text; v_user text;
BEGIN
  SELECT schedule, username INTO v_sched, v_user FROM cron.job WHERE jobname = 'rpc-panini-products-bridge';
  IF v_sched IS DISTINCT FROM '24,54 * * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user IS DISTINCT FROM 'cron_heavy' THEN RAISE EXCEPTION 'owner is not cron_heavy: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-panini-products-bridge') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
