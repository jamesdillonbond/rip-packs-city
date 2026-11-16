-- audit_20261115_pack_ev_history_thin_identical_runs
--
-- WHY (inbox 2026-11-15T2311Z; Trevor 11-15 ~5:30 PM PT: "work through it all"):
-- pack_ev_history had no pruning and has grown ~187k rows/week since the hourly
-- refresh_atlas_pack_ev (job 217) started writing one row per Atlas dist per hour
-- (10-12). ~77 % of those rows repeat the same pack's previous snapshot exactly.
-- 1.41M rows / 902 MB on 11-15; job 73 (refresh_mv_pack_ev_latest, a DISTINCT ON
-- over the whole table) averaged 31.6 s and analytics_packs_summary's cold calls
-- hit the 30 s service_role cap, both scaling with the row count.
--
-- WHAT: delete only the INTERIOR rows of an identical run — a row whose every
-- column except id and snapshotted_at equals BOTH its previous and next row for the
-- same pack_listing_id — and only rows older than a cutoff. Each run keeps its first
-- and last row, so:
--   * every pack's newest row is untouched, and so is "newest row passing a filter"
--     (pack_ev_latest, mv_pack_ev_latest, get_pack_realized_ev_row, the analytics
--     summary, v_topshot_atlas_pool_targets): a deleted row's run-last twin is
--     newer, has the same values, and passes the same filter;
--   * count(DISTINCT pack_listing_id) (trust-health pack_ev_publish_shortfall_pct)
--     and max(snapshotted_at) per dist (topshot_pack_ev_targets) are unchanged;
--   * time-series readers (get_pack_ev_history, analytics_packs_history) draw the
--     same step function from fewer points.
-- Readers audited 11-15 (15 functions, 5 views, app routes): none counts or averages
-- snapshots over time.
--
-- ⛔ Do NOT instead make the writer skip unchanged rows: public readers gate on a
-- 72 h freshness bar on snapshotted_at, so an unchanged pack would fall off boards.
--
-- The comparison is on the row's TEXT form, so 1.5 vs 1.50 counts as different and
-- is kept: it can only under-delete.
--
-- BACKUP (one-off only): audit_20261115_pack_ev_history_thinned keeps (id,
-- pack_listing_id, snapshotted_at) of every deleted row. That is enough to rebuild
-- each row exactly: its values equal the nearest surviving row before it.
--
-- REVERT (data):
--   INSERT INTO public.pack_ev_history
--   SELECT b.id, p.pack_listing_id, p.collection_id, p.dist_id, p.pack_name, p.pack_price,
--          p.gross_ev, p.pack_ev, p.is_positive_ev, p.value_ratio, p.fmv_coverage_pct,
--          p.edition_count, p.total_unopened, p.depletion_pct, b.snapshotted_at,
--          p.primary_price, p.secondary_ask, p.price_source, p.primary_available,
--          p.secondary_available, p.typical_ev
--   FROM public.audit_20261115_pack_ev_history_thinned b
--   CROSS JOIN LATERAL (SELECT * FROM public.pack_ev_history h
--     WHERE h.pack_listing_id = b.pack_listing_id AND h.snapshotted_at < b.snapshotted_at
--     ORDER BY h.snapshotted_at DESC, h.id DESC LIMIT 1) p;
-- ONE-OFF (run after this migration, by the session that applied it, in batches):
--   SELECT public.thin_pack_ev_history_chunk('-infinity', '2026-11-01 00:00:00+00', <after>, 200, true);
-- REVERT (objects): SELECT cron.unschedule('rpc-pack-ev-history-thin');
--   DROP PROCEDURE public.thin_pack_ev_history_all(timestamptz, timestamptz, boolean, integer);
--   DROP FUNCTION public.thin_pack_ev_history_chunk(timestamptz, timestamptz, text, integer, boolean);
--   (keep the audit table until the data revert is no longer wanted.)

CREATE TABLE IF NOT EXISTS public.audit_20261115_pack_ev_history_thinned (
  id              uuid PRIMARY KEY,
  pack_listing_id text NOT NULL,
  snapshotted_at  timestamptz NOT NULL
);
ALTER TABLE public.audit_20261115_pack_ev_history_thinned ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261115_pack_ev_history_thinned FROM PUBLIC, anon, authenticated;

-- One batch: the packs strictly after p_after_listing, p_listings of them in
-- pack_listing_id order. Returns the deleted count and the batch's last pack id
-- (NULL when there were no packs left), so a caller can page.
CREATE OR REPLACE FUNCTION public.thin_pack_ev_history_chunk(
  p_since         timestamptz,
  p_before        timestamptz,
  p_after_listing text,
  p_listings      integer,
  p_record        boolean
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_last    text;
  v_deleted integer := 0;
BEGIN
  IF p_before > now() - interval '7 days' THEN
    RAISE EXCEPTION 'thin_pack_ev_history_chunk: cutoff % is newer than 7 days', p_before;
  END IF;

  SELECT max(pl) INTO v_last FROM (
    SELECT DISTINCT h.pack_listing_id AS pl
    FROM public.pack_ev_history h
    WHERE h.pack_listing_id > COALESCE(p_after_listing, '')
      AND h.snapshotted_at >= p_since AND h.snapshotted_at < p_before
    ORDER BY 1
    LIMIT GREATEST(p_listings, 1)
  ) s;

  IF v_last IS NULL THEN
    RETURN jsonb_build_object('deleted', 0, 'last_listing', NULL);
  END IF;

  WITH w AS (
    SELECT h.id, h.pack_listing_id, h.snapshotted_at,
      md5(row(h.collection_id, h.dist_id, h.pack_name, h.pack_price, h.gross_ev, h.pack_ev,
              h.is_positive_ev, h.value_ratio, h.fmv_coverage_pct, h.edition_count,
              h.total_unopened, h.depletion_pct, h.primary_price, h.secondary_ask,
              h.price_source, h.primary_available, h.secondary_available, h.typical_ev)::text) AS v
    FROM public.pack_ev_history h
    WHERE h.pack_listing_id > COALESCE(p_after_listing, '')
      AND h.pack_listing_id <= v_last
      -- Only a slice around the cutoff. A row whose neighbour falls outside it gets a
      -- NULL lag/lead and is KEPT, so a narrow slice can only under-delete.
      AND h.snapshotted_at >= p_since
      AND h.snapshotted_at <  p_before + interval '2 days'
  ), x AS (
    SELECT id, pack_listing_id, snapshotted_at, v,
           lag(v)  OVER p AS pv,
           lead(v) OVER p AS nv
    FROM w
    WINDOW p AS (PARTITION BY pack_listing_id ORDER BY snapshotted_at, id)
  ), d AS (
    DELETE FROM public.pack_ev_history h
    USING x
    WHERE h.id = x.id
      AND x.snapshotted_at < p_before
      AND x.v = x.pv AND x.v = x.nv
    RETURNING h.id, h.pack_listing_id, h.snapshotted_at
  ), b AS (
    INSERT INTO public.audit_20261115_pack_ev_history_thinned (id, pack_listing_id, snapshotted_at)
    SELECT id, pack_listing_id, snapshotted_at FROM d WHERE p_record
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM d;

  RETURN jsonb_build_object('deleted', v_deleted, 'last_listing', v_last);
END
$fn$;

REVOKE ALL ON FUNCTION public.thin_pack_ev_history_chunk(timestamptz, timestamptz, text, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.thin_pack_ev_history_chunk(timestamptz, timestamptz, text, integer, boolean) TO service_role;

-- Every pack, one committed batch at a time; a heartbeat first, one completion
-- row at the end (rows_written = rows deleted).
-- No SET clause: a SET on a procedure that COMMITs breaks it.
CREATE OR REPLACE PROCEDURE public.thin_pack_ev_history_all(
  p_since    timestamptz,
  p_before   timestamptz,
  p_record   boolean DEFAULT false,
  p_listings integer DEFAULT 200
)
LANGUAGE plpgsql
AS $pr$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_after   text := '';
  v_res     jsonb;
  v_total   integer := 0;
  v_batches integer := 0;
BEGIN
  PERFORM public.log_pipeline_run('pack-ev-history-thin-heartbeat', true,
    jsonb_build_object('since', p_since, 'before', p_before, 'record', p_record));
  COMMIT;
  LOOP
    v_res := public.thin_pack_ev_history_chunk(p_since, p_before, v_after, p_listings, p_record);
    EXIT WHEN v_res->>'last_listing' IS NULL;
    v_total   := v_total + (v_res->>'deleted')::int;
    v_batches := v_batches + 1;
    v_after   := v_res->>'last_listing';
    COMMIT;
  END LOOP;
  PERFORM public.log_pipeline_run('pack-ev-history-thin', v_started, v_total, v_total, 0, true, NULL,
    NULL, NULL, v_after,
    jsonb_build_object('since', p_since, 'before', p_before, 'record', p_record, 'batches', v_batches,
                       'seconds', round(extract(epoch FROM clock_timestamp() - v_started))));
  COMMIT;
  -- No EXCEPTION block: COMMIT is not allowed inside one. A run that dies leaves a
  -- heartbeat with no completion row, which is how a kill is read here.
END
$pr$;

REVOKE ALL ON PROCEDURE public.thin_pack_ev_history_all(timestamptz, timestamptz, boolean, integer) FROM PUBLIC, anon, authenticated;

-- Daily 5:01 AM PT (13:01 UTC): thin what has just turned 14 days old. Daily, not
-- weekly, so the lane stays inside pipeline_runs' ~73 h retention and can be watched;
-- each run reads only ~5 days of rows (17 d → 12 d old). Each row is judged in three
-- runs, so a pack's first row in a slice (no previous row in view, so kept) was
-- already judged with both neighbours, and a missed day is caught up.
SELECT cron.schedule('rpc-pack-ev-history-thin', '1 13 * * *',
  $cmd$CALL public.thin_pack_ev_history_all(now() - interval '17 days', now() - interval '14 days', false, 200);$cmd$);
