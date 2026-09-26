-- audit_20260925_panini_bridge_into_shared_tables
--
-- ⛔ SUPERSEDED THE SAME NIGHT by 20260926041443_panini_bridge_honours_the_accuracy_gate_and_nation_is_not_a_team:
-- this body wrote panini_editions.nation into team_name (go-live doc gap 3 forbids it) and
-- bypassed the gated sync_panini_editions_to_shared. Kept verbatim as the record of what ran.
--
-- known-issues #64: Panini lives only in panini_* tables (5,094 editions, 72,572 FMV snapshots on
-- 2026-09-25), so every shared surface — get_collection_stats, edition_fmv_current, the
-- collection overview — sees ZERO Panini editions. This bridges the Panini-native tables into the
-- shared ones, one-way, on a schedule:
--
--   panini_editions        → editions            (collection d1a0a7f5…, external_id = panini_editions.external_id,
--                                                  UNIQUE on both sides — 5,094/5,094 measured)
--   panini_fmv_snapshots   → fmv_snapshots        (joined panini id → external_id → editions.id; a snapshot is
--                                                  "already bridged" when (edition, computed_at, algo) exists)
--   latest bridged snapshot → edition_fmv_current (upserted HERE: the incremental refresh only looks 2 h behind
--                                                  its global watermark, so a backfill would never reach it)
--
-- The Panini writer (cron panini-ingest) commits a few rows per minute with client-side
-- computed_at, so a max(computed_at) watermark could skip a batch that commits late. The sync
-- instead re-checks a lookback window (default 6 h) with NOT EXISTS — idempotent by construction.
-- p_lookback NULL = full history (the one-time backfill).
--
-- The shared guards stay in force and are NOT bypassed: fmv_snapshots_block_phantoms nulls a
-- >$10k price unless HIGH with ≥3 sales (215 of 72,572 historical Panini rows; Panini has no
-- sales_count_30d, so every >$10k Panini price is withheld rather than shown). Panini's own
-- boards keep their own numbers.
--
-- Global writers that could overwrite a bridged price, checked 2026-09-25:
--   drain_fmv_cold_tail   — route passes 4 Flow slugs only (STALE_COLLECTIONS); never Panini.
--   recalc_ultimate_fmv   — walks every tier='ULTIMATE' edition (357 Panini) but inserts only a
--                           non-null fmv from sales / cached_listings; Panini has 0 rows in both.
--   fmv-recalc et al.     — driven by `sales` / Flow listing feeds; no Panini rows.
--
-- Logged every run as `panini-bridge-sync` (rows_written = snapshots copied, NULL on failure).
-- Every 30 min at :14/:44 as cron_heavy.
--
-- anon-exec: revoked (sync_panini_bridge) — new function; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT: SELECT cron.unschedule('rpc-panini-bridge-sync');
--         DROP FUNCTION IF EXISTS public.sync_panini_bridge(interval);
--         (bridged rows: DELETE FROM edition_fmv_current / fmv_snapshots / editions
--          WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b' — editions has a
--          destructive-delete guard; follow its bypass procedure.)

CREATE OR REPLACE FUNCTION public.sync_panini_bridge(p_lookback interval DEFAULT interval '6 hours')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  c_coll     constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_started  timestamptz := clock_timestamp();
  v_since    timestamptz;
  v_eds      integer := 0;
  v_snaps    integer := 0;
  v_efc      integer := 0;
  v_ok       boolean := true;
  v_err      text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('sync_panini_bridge')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  v_since := CASE WHEN p_lookback IS NULL THEN '-infinity'::timestamptz ELSE now() - p_lookback END;

  BEGIN
    -- 1. Editions: insert new, update only rows whose bridged fields changed.
    WITH src AS (
      SELECT pe.external_id, pe.player_name, pe.set_name, pe.tier, pe.mint_cap,
             pe.thumbnail_url, pe.video_url, pe.first_minted_at, pe.nation,
             concat_ws(' · ', pe.player_name, pe.set_name) AS name
        FROM public.panini_editions pe
    ),
    up AS (
      INSERT INTO public.editions AS e
        (external_id, collection_id, collection, name, player_name, set_name, team_name, tier,
         circulation_count, thumbnail_url, video_url, first_minted_at, last_updated_at)
      SELECT s.external_id, c_coll, 'panini_blockchain', s.name, s.player_name, s.set_name, s.nation, s.tier,
             s.mint_cap, s.thumbnail_url, s.video_url, s.first_minted_at, now()
        FROM src s
      ON CONFLICT (external_id, collection_id) DO UPDATE SET
        name = EXCLUDED.name, player_name = EXCLUDED.player_name, set_name = EXCLUDED.set_name,
        team_name = EXCLUDED.team_name, tier = EXCLUDED.tier, circulation_count = EXCLUDED.circulation_count,
        thumbnail_url = EXCLUDED.thumbnail_url, video_url = EXCLUDED.video_url,
        first_minted_at = EXCLUDED.first_minted_at, last_updated_at = EXCLUDED.last_updated_at
      WHERE (e.name, e.player_name, e.set_name, e.team_name, e.tier, e.circulation_count,
             e.thumbnail_url, e.video_url, e.first_minted_at)
            IS DISTINCT FROM
            (EXCLUDED.name, EXCLUDED.player_name, EXCLUDED.set_name, EXCLUDED.team_name, EXCLUDED.tier,
             EXCLUDED.circulation_count, EXCLUDED.thumbnail_url, EXCLUDED.video_url, EXCLUDED.first_minted_at)
      RETURNING 1
    )
    SELECT count(*)::int INTO v_eds FROM up;

    -- 2. Snapshots in the window that are not yet bridged.
    CREATE TEMP TABLE IF NOT EXISTS _panini_bridge_touched (edition_id uuid PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _panini_bridge_touched;

    WITH ins AS (
      INSERT INTO public.fmv_snapshots
        (edition_id, collection_id, collection, fmv_usd, confidence, algo_version, computed_at)
      SELECT e.id, c_coll, 'panini_blockchain', ps.fmv_usd, ps.confidence, ps.algo_version, ps.computed_at
        FROM public.panini_fmv_snapshots ps
        JOIN public.panini_editions pe ON pe.id = ps.edition_id
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
      INSERT INTO _panini_bridge_touched SELECT DISTINCT edition_id FROM ins
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM ins) INTO v_snaps;

    -- 3. edition_fmv_current for every touched edition, from its latest snapshot (post-trigger
    --    values). Never moves a row backwards — same rule as refresh_edition_fmv_current.
    WITH latest AS MATERIALIZED (
      SELECT tt.edition_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
        FROM _panini_bridge_touched tt
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
    v_eds := NULL; v_snaps := NULL; v_efc := NULL;
  END;

  PERFORM public.log_pipeline_run('panini-bridge-sync', v_started, NULL, v_snaps, NULL, v_ok, v_err,
                                  'panini_blockchain', NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'via', 'pg_cron',
                                                     'lookback', COALESCE(p_lookback::text, 'full'),
                                                     'editions_written', v_eds,
                                                     'snapshots_written', v_snaps,
                                                     'efc_written', v_efc));
  RETURN jsonb_build_object('ok', v_ok, 'error', v_err, 'editions_written', v_eds,
                            'snapshots_written', v_snaps, 'efc_written', v_efc);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_panini_bridge(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_panini_bridge(interval) TO service_role, cron_heavy;

-- The NOT EXISTS probe and the window scan both need an index on the Panini side.
CREATE INDEX IF NOT EXISTS idx_panini_fmv_snapshots_computed_at
  ON public.panini_fmv_snapshots (computed_at);

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-panini-bridge-sync',
  '14,44 * * * *',
  'SELECT public.sync_panini_bridge();'
);
RESET ROLE;

DO $$
DECLARE v_sched text; v_user text;
BEGIN
  SELECT schedule, username INTO v_sched, v_user FROM cron.job WHERE jobname = 'rpc-panini-bridge-sync';
  IF v_sched IS DISTINCT FROM '14,44 * * * *' THEN RAISE EXCEPTION 'schedule not applied: %', v_sched; END IF;
  IF v_user IS DISTINCT FROM 'cron_heavy' THEN RAISE EXCEPTION 'owner is not cron_heavy: %', v_user; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-panini-bridge-sync') <> 1 THEN
    RAISE EXCEPTION 'duplicate job created';
  END IF;
END $$;
