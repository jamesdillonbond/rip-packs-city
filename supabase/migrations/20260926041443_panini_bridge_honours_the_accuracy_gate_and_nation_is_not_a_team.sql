-- panini_bridge_honours_the_accuracy_gate_and_nation_is_not_a_team
--
-- Corrects 20260926041006 (applied ~9:10 PM PT 2026-09-25, same session), which bridged Panini
-- into the shared tables with its OWN editions upsert. Two things it got wrong, both already
-- decided in docs/strategy/panini-go-live-2026-09-19.md and migration 20260920155903:
--
--   1. It wrote panini_editions.nation into editions.team_name — 659 rows. Gap 3: A NATION IS NOT
--      A TEAM (the column also holds host cities and "FIFA"; team_name feeds /team/[slug],
--      /my-teams and the team OG card). Those 659 are NULLed here, and the new body never writes it.
--   2. It bypassed sync_panini_editions_to_shared, the gated writer that enforces the go-live
--      doc's exit bar (pct_editions_stale_45d ≤ 1.0, FAIL-CLOSED on an unreadable coverage row)
--      and creates the 62 sets / 552 players rows the editions link to.
--
-- Measured before this migration (~9:25 PM PT): pct_editions_stale_45d 0.0 (0 of 5,094), walked
-- ≤7 d 100%, age p50 22.5 h / p90 38.9 h; dry run blocked=false, 0 slug collisions. So the gate
-- was open when 041006 wrote — the write was not stale, but it must not be ABLE to be.
--
-- New body:
--   • reads panini_coverage_summary FAIL-CLOSED and writes NOTHING (ok=false, logged) above the
--     same 1.0 ceiling — the snapshot/price half obeys the gate too, not just the catalogue half;
--   • editions/sets/players go through sync_panini_editions_to_shared(false), called only when a
--     Panini edition is missing from `editions` or its bridged fields drifted (that function
--     rewrites all 5,094 rows unconditionally, so calling it every 30 min would churn the table);
--   • snapshots → fmv_snapshots and latest → edition_fmv_current, unchanged from 041006.
--
-- Signature unchanged (interval DEFAULT '6 hours'), so this REPLACES rather than overloads and
-- keeps the ACL (REVOKE restated below for the anon-exec guard; it is a no-op on the live ACL).
--
-- anon-exec: revoked (sync_panini_bridge) — REVOKE FROM PUBLIC, anon, authenticated restated below.
--
-- REVERT: re-apply the body from 20260926041006 (not recommended — it writes team_name), or
--         SELECT cron.unschedule('rpc-panini-bridge-sync');

UPDATE public.editions
   SET team_name = NULL
 WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
   AND team_name IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_panini_bridge(p_lookback interval DEFAULT interval '6 hours')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  -- Same ceiling as sync_panini_editions_to_shared (go-live doc §4 step 1). Moving it is a new
  -- migration, on purpose.
  MAX_STALE_PCT constant numeric := 1.0;
  c_coll     constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_started  timestamptz := clock_timestamp();
  v_since    timestamptz;
  v_stale    numeric;
  v_total    bigint;
  v_drift    integer := 0;
  v_catalog  jsonb := NULL;
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
    -- ACCURACY GATE, fail-closed: no row, a NULL percentage or a zero denominator all refuse.
    SELECT pct_editions_stale_45d, total_editions INTO v_stale, v_total FROM public.panini_coverage_summary;
    IF NOT FOUND OR v_stale IS NULL OR v_total IS NULL OR v_total = 0 THEN
      RAISE EXCEPTION 'panini coverage reading unusable (pct=%, total=%) -- a failed read is not permission', v_stale, v_total;
    END IF;
    IF v_stale > MAX_STALE_PCT THEN
      RAISE EXCEPTION 'blocked_by_staleness: % percent of Panini editions not re-priced in 45+ days (ceiling % percent)', v_stale, MAX_STALE_PCT;
    END IF;

    -- 1. Catalogue: only when an edition is missing or its bridged fields drifted.
    SELECT count(*)::int INTO v_drift
      FROM public.panini_editions pe
      LEFT JOIN public.editions e ON e.collection_id = c_coll AND e.external_id = pe.external_id
     WHERE e.id IS NULL
        OR (e.tier, e.circulation_count, e.player_name, e.set_name)
           IS DISTINCT FROM (pe.tier, pe.mint_cap, pe.player_name, pe.set_name);
    IF v_drift > 0 THEN
      v_catalog := public.sync_panini_editions_to_shared(false);
    END IF;

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
    v_catalog := NULL; v_snaps := NULL; v_efc := NULL;
  END;

  PERFORM public.log_pipeline_run('panini-bridge-sync', v_started, NULL, v_snaps, NULL, v_ok, v_err,
                                  'panini_blockchain', NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'via', 'pg_cron',
                                                     'lookback', COALESCE(p_lookback::text, 'full'),
                                                     'pct_stale_45d', v_stale,
                                                     'catalog_drift', v_drift,
                                                     'catalog', v_catalog,
                                                     'snapshots_written', v_snaps,
                                                     'efc_written', v_efc));
  RETURN jsonb_build_object('ok', v_ok, 'error', v_err, 'pct_stale_45d', v_stale, 'catalog_drift', v_drift,
                            'catalog', v_catalog, 'snapshots_written', v_snaps, 'efc_written', v_efc);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_panini_bridge(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_panini_bridge(interval) TO service_role, cron_heavy;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.editions
              WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b' AND team_name IS NOT NULL) THEN
    RAISE EXCEPTION 'Panini team_name still populated';
  END IF;
  IF position('nation' in (SELECT prosrc FROM pg_proc WHERE proname = 'sync_panini_bridge')) > 0 THEN
    RAISE EXCEPTION 'sync_panini_bridge still references the nation column';
  END IF;
END $$;
