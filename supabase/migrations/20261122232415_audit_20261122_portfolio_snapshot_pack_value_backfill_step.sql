-- audit_20261122_portfolio_snapshot_pack_value_backfill_step
--
-- Follow-up to 20261122231506 (same afternoon). The procedure's first pg_cron run (3:19 PM PT)
-- died at the 120 s default statement_timeout inside the first owner's paged
-- get_wallet_pack_history reads: a pg_cron CALL is ONE statement, and COMMIT inside a
-- procedure does not re-arm the timer, while a "SET statement_timeout …;" prefix would make the
-- command a transaction block that COMMIT cannot run in. So the work moves to a FUNCTION the
-- job calls under "SET statement_timeout = '600s'; SELECT …" (one transaction per run, saved at
-- the end; a soft budget well under the timeout). Measured: the per-night calculation for the
-- largest owner (30 nights, 2,980 held dist-nights) is 0.77 s — the reads are the cost.
--
-- Owners whose rows are still NULL after a run are picked up by the next one. An owner whose
-- read fails is stamped pack_value_basis = 'backfill_failed' on its rows (values stay NULL) so
-- one bad owner cannot block the queue; the chart treats NULL values as "no pack value".
--
-- Revert: DROP FUNCTION public.backfill_portfolio_snapshot_pack_values_step(integer, integer);
--         UPDATE public.portfolio_snapshots SET pack_value_basis = NULL WHERE pack_value_basis = 'backfill_failed';

CREATE OR REPLACE FUNCTION public.backfill_portfolio_snapshot_pack_values_step(
  p_days integer DEFAULT 30, p_budget_seconds integer DEFAULT 300)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_owner text;
  v_rows jsonb;
  v_done integer := 0;
  v_failed integer := 0;
  v_left integer := 0;
  v_hourly_from timestamptz;
BEGIN
  SELECT min(hour_bucket) INTO v_hourly_from FROM public.pack_ask_hourly_low;

  FOR v_owner IN
    SELECT ps.owner_key
    FROM public.portfolio_snapshots ps
    WHERE ps.snapshot_date >= CURRENT_DATE - p_days
      AND ps.snapshot_date < CURRENT_DATE
      AND ps.pack_low_ask_usd IS NULL
      AND ps.pack_value_basis IS NULL
    GROUP BY ps.owner_key
    ORDER BY ps.owner_key
  LOOP
    IF clock_timestamp() - v_started > make_interval(secs => p_budget_seconds) THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;

    v_rows := public.portfolio_owner_pack_rows(v_owner);
    IF v_rows IS NULL THEN
      UPDATE public.portfolio_snapshots ps
         SET pack_value_basis = 'backfill_failed'
       WHERE ps.owner_key = v_owner
         AND ps.snapshot_date >= CURRENT_DATE - p_days
         AND ps.snapshot_date < CURRENT_DATE
         AND ps.pack_low_ask_usd IS NULL;
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;

    WITH pk AS (
      SELECT (x->>'cid')::uuid AS cid, x->>'slug' AS slug, x->>'dist' AS dist,
             (x->>'acq')::timestamptz AS acq, (x->>'dep')::timestamptz AS dep
      FROM jsonb_array_elements(v_rows) x
    ),
    nights AS (
      SELECT ps.id, ps.created_at AS t
      FROM public.portfolio_snapshots ps
      WHERE ps.owner_key = v_owner
        AND ps.snapshot_date >= CURRENT_DATE - p_days
        AND ps.snapshot_date < CURRENT_DATE
        AND ps.pack_low_ask_usd IS NULL
    ),
    held AS (
      SELECT n.id, n.t, pk.cid, pk.slug, pk.dist, count(*)::int AS cnt
      FROM nights n
      JOIN pk ON pk.acq IS NOT NULL AND pk.acq <= n.t AND (pk.dep IS NULL OR pk.dep > n.t)
      GROUP BY 1, 2, 3, 4, 5
    ),
    valued AS (
      SELECT h.id, h.cnt, h.dist,
        CASE WHEN h.t >= v_hourly_from THEN a_then.low_ask ELSE a_first.low_ask END AS ask,
        GREATEST(ls.sale_price, ev.gross_ev, obs.avg_value_usd) AS ref
      FROM held h
      LEFT JOIN LATERAL (
        SELECT a.low_ask FROM public.pack_ask_hourly_low a
        WHERE h.t >= v_hourly_from AND h.dist IS NOT NULL
          AND a.collection_slug = h.slug AND a.dist_id = h.dist
          AND a.hour_bucket <= h.t AND a.hour_bucket > h.t - interval '24 hours'
        ORDER BY a.hour_bucket DESC LIMIT 1) a_then ON true
      LEFT JOIN LATERAL (
        SELECT a.low_ask FROM public.pack_ask_hourly_low a
        WHERE h.t < v_hourly_from AND h.dist IS NOT NULL
          AND a.collection_slug = h.slug AND a.dist_id = h.dist
        ORDER BY a.hour_bucket ASC LIMIT 1) a_first ON true
      LEFT JOIN LATERAL (
        SELECT pp.sale_price FROM public.pack_purchases pp
        WHERE h.dist IS NOT NULL AND pp.pack_dist_id = h.dist AND pp.collection_id = h.cid
          AND pp.event_kind = 'secondary_sale' AND pp.sale_price IS NOT NULL AND pp.sealed_at <= h.t
        ORDER BY pp.sealed_at DESC LIMIT 1) ls ON true
      LEFT JOIN LATERAL (
        SELECT e.gross_ev FROM public.pack_ev_history e
        WHERE h.dist IS NOT NULL AND e.collection_id = h.cid AND e.dist_id = h.dist
          AND e.snapshotted_at <= h.t
          AND NOT (e.gross_ev = 0 AND e.edition_count = 0)
          AND (e.fmv_coverage_pct IS NULL OR e.fmv_coverage_pct >= 25)
        ORDER BY e.snapshotted_at DESC LIMIT 1) ev ON true
      LEFT JOIN public.pack_observed_values obs
        ON obs.dist_id = h.dist AND obs.collection_id = h.cid AND obs.n_valued >= 5
    ),
    per_night AS (
      SELECT n.id, n.t,
        COALESCE(sum(v.cnt), 0)::int AS held_n,
        COALESCE(sum(v.cnt) FILTER (WHERE v.ask IS NOT NULL AND v.ref IS NOT NULL), 0)::int AS listed_n,
        round(COALESCE(sum(v.cnt * LEAST(v.ask, 3 * v.ref)) FILTER (WHERE v.ask IS NOT NULL AND v.ref IS NOT NULL), 0), 2) AS low_usd
      FROM nights n
      LEFT JOIN valued v ON v.id = n.id
      GROUP BY n.id, n.t
    )
    UPDATE public.portfolio_snapshots ps
       SET pack_low_ask_usd  = pn.low_usd,
           pack_held_count   = pn.held_n,
           pack_listed_count = pn.listed_n,
           pack_value_basis  = CASE WHEN pn.t >= v_hourly_from THEN 'hourly_ask' ELSE 'carried_back_ask' END
      FROM per_night pn
     WHERE ps.id = pn.id AND ps.pack_low_ask_usd IS NULL;

    v_done := v_done + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('portfolio-snapshot-packs-backfill', v_started, v_done + v_failed + v_left,
    v_done, v_failed, v_failed = 0 AND v_left = 0, NULL, NULL, NULL, NULL,
    jsonb_build_object('owners_filled', v_done, 'owners_failed', v_failed, 'over_budget', v_left,
                       'seconds', round(extract(epoch FROM clock_timestamp() - v_started))));
  RETURN jsonb_build_object('owners_filled', v_done, 'owners_failed', v_failed, 'over_budget', v_left);
END
$fn$;

-- anon-exec: revoked (backfill_portfolio_snapshot_pack_values_step) — new function; writes every owner's snapshot rows, service-only.
REVOKE ALL ON FUNCTION public.backfill_portfolio_snapshot_pack_values_step(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_portfolio_snapshot_pack_values_step(integer, integer) TO postgres, service_role;
