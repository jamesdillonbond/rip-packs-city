-- ⛔ REPAIRING A CLOBBER I CAUSED. Read this before touching get_series_detail.
--
-- Two sessions fixed the same function the same night, and I overwrote the other
-- one without noticing. Timeline from supabase_migrations.schema_migrations (UTC):
--
--   01:58  I measure get_series_detail at 21 s / 3,600 editions and read its
--          body — at that moment it really did hold the per-edition lateral.
--   03:14  audit_20260823_series_detail_rollup        (other session creates the table)
--   03:16  audit_20260823_get_series_detail_reads_the_rollup  (other session SWAPS the reader)
--   03:21  audit_20260823_watchlist_series_detail_rollup      (staleness arm, 180 min, medium)
--   03:23  audit_20260823_series_rollup_cron_schedule         (jobid 357)
--   05:16  I build a DUPLICATE rollup, never having re-read the function
--   05:18  I CREATE OR REPLACE get_series_detail -> points at my duplicate
--   05:20  I CREATE OR REPLACE it again -> points at series_detail_rollup
--
-- So "the rollup existed and get_series_detail simply never read it" is FALSE.
-- It had been reading it for two hours. My diagnosis was correct at 01:58 and
-- stale by 03:16, and I never re-checked before writing to a shared object.
-- ⚠ A 21-minute-old rollup and a 21-month-old rollup look identical. Freshness
-- is not provenance — `schema_migrations` is, and it was one query away.
--
-- WHAT THE CLOBBER COST: their body returned a 13th key, `stats_computed_at`,
-- carrying series_detail_rollup.computed_at. Mine dropped it. Nothing in
-- app/ lib/ components/ __tests__/ reads that key today (checked), so no live
-- surface broke — but the repo's committed migration (git 2bca41b4) promises it
-- and production stopped delivering it, which is exactly the kind of drift the
-- next reader resolves in favour of the file. Restored here.
--
-- WHAT I KEPT, deliberately, and it is the one real difference between the two
-- implementations: the per-branch LIVE FALLBACK. Their version reads the rollup
-- unconditionally, so a series with no rollup row returns NULL counts. Mine
-- falls back to the original computation, so a newly added series is
-- slow-but-correct instead of fast-and-wrong. That is the accuracy-side choice.
--
-- Also already done by that session, and therefore NOT still-open as I reported:
-- the staleness arm. `pipeline_cadence_watchlist('series-detail-rollup', 180 min,
-- medium)` was added at 03:21 with the right reasoning written into its notes —
-- a frozen rollup keeps the pages fast and the RPC fully populated, so silence
-- is the only alarm.
--
-- REVERT: re-apply audit_20260823_get_series_detail_reads_existing_series_detail_rollup
-- (this body minus the stats_computed_at key), or git 2bca41b4 for theirs.
CREATE OR REPLACE FUNCTION public.get_series_detail(p_collection_id uuid, p_series_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid     CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_series            RECORD;
  v_collection_slug   text;
  v_edition_count     int;
  v_total_circulation bigint;
  v_fmv_total         numeric;
  v_floor_total       numeric;
  v_set_count         int;
  v_player_count      int;
  v_computed_at       timestamptz;
  v_pinnacle_year     int;
  v_hit               boolean := false;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN NULL; END IF;

  -- FAST PATH: the rollup refreshed by jobid 357 `rpc-series-detail-rollup`.
  SELECT true, r.edition_count, r.total_circulation, r.fmv_total_usd,
         r.floor_total_usd, r.set_count, r.player_count, r.computed_at
  INTO v_hit, v_edition_count, v_total_circulation, v_fmv_total,
       v_floor_total, v_set_count, v_player_count, v_computed_at
  FROM series_detail_rollup r
  WHERE r.collection_id = p_collection_id
    AND r.series_number = v_series.series_number;

  IF NOT COALESCE(v_hit, false) THEN
    -- No rollup row yet. Correctness over latency: compute it live rather than
    -- report zeros. v_computed_at stays NULL, which is the honest answer for a
    -- value that did not come from the rollup.
    IF p_collection_id = v_pinnacle_uuid THEN
      BEGIN
        v_pinnacle_year := v_series.season::int;
      EXCEPTION WHEN invalid_text_representation THEN
        v_pinnacle_year := NULL;
      END;

      IF v_pinnacle_year IS NOT NULL THEN
        SELECT
          COUNT(*),
          SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
          SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
          SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
          COUNT(DISTINCT pe.set_name),
          COUNT(DISTINCT pe.character_name)
        INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count
        FROM pinnacle_editions pe
        LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
        WHERE pe.series_year = v_pinnacle_year;
      END IF;
    ELSE
      SELECT
        COUNT(*),
        SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
        SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        COUNT(DISTINCT e.set_name),
        COUNT(DISTINCT COALESCE(e.player_id::text, e.player_name))
      INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = v_series.series_number;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'series_slug',       p_series_slug,
    'series_number',     v_series.series_number,
    'display_label',     v_series.display_label,
    'season',            v_series.season,
    'edition_count',     COALESCE(v_edition_count, 0),
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'set_count',         COALESCE(v_set_count, 0),
    'player_count',      COALESCE(v_player_count, 0),
    'stats_computed_at', v_computed_at
  );
END;
$function$;