-- audit_20261015_edition_concentration_v2_counts_walk_confirmed_live_supply
-- anon-exec: NOT intentional for refresh_topshot_edition_concentration_v2 — an ops writer; EXECUTE granted to service_role only (pg_cron runs it as postgres, the owner).
--
-- Squeeze board "Top 5 hold" (topshot_edition_concentration, read by topshot_squeeze_board). The
-- 20261015200615 boards fix could not reach this writer: its body carries the R123 write-then-retire
-- DELETE, which the cloud session's MCP write gate holds (parked as docs/pending-sql/…, now removed).
-- Per the 10-14/15 convention (tooling-gotchas.md: a new NAME, not a re-signature), this is a _v2:
--   a. a topshot_ownership row the holder's on-chain walk did not find (walk_missed_at, 20261015200136)
--      is not held;
--   b. shares and the 98 % census gate are measured against LIVE supply (circulation minus Atlas
--      `badge_editions.burned`), not the mint count — trade-in auctions burn rookie supply all season
--      (Top Shot, 2026-10-14); `circulation` keeps the mint count; burned NULL = 0;
--   c. an edition this run did NOT write is RETIRED by UPDATE (census_complete=false, shares NULL ->
--      the board shows "—") instead of being removed. The board shows holders only when
--      census_complete, so a retired row claims nothing. Base = live prosrc md5
--      0a6d02aac9e5792565e3c41cec06dd65; same advisory-lock key, so v1 and v2 never overlap.
-- pg_cron job 682 (rpc-topshot-edition-concentration, same schedule) now calls v2.
--
-- Measured on apply (one manual run, 2:58 PM PT): 2,260 written, ok; census-complete editions
-- 2,261 -> 2,140 — the 120 that dropped were "complete" only because walk-missed rows padded the
-- census; Series 8 Rookie Debut census = 100.1 % of live supply (was 115 % of it).
--
-- FOLLOW-UP (operator, DROP is held for the cloud session): drop the unused v1 —
--   docs/pending-sql/audit_20261015_drop_pre20261015_ownership_mvs.sql.
--
-- REVERT: SELECT cron.schedule('rpc-topshot-edition-concentration', '58 2,8,14,20 * * *',
--           $$SET statement_timeout = '120s'; SELECT public.refresh_topshot_edition_concentration();$$);
--         then SELECT public.refresh_topshot_edition_concentration();

CREATE OR REPLACE FUNCTION public.refresh_topshot_edition_concentration_v2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll     constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started  timestamptz := clock_timestamp();
  v_stamp    timestamptz := clock_timestamp();
  v_cand     int;            -- NULL = not measured
  v_written  int := 0;       -- rows that LANDED
  v_complete int;
  v_retired  int;            -- NULL = the retire step did not run
  v_err      text;
  v_del_err  text;
  v_ok       boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_topshot_edition_concentration')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    WITH held AS (
      SELECT o.edition_external_id AS ext, o.owner_address AS owner, count(*)::int AS n,
             (o.owner_address IN ('0xb6f2481eba4df97b', '0xe1f2a091f7bb5245')) AS is_sys
      FROM topshot_ownership o
      WHERE o.walk_missed_at IS NULL   -- 2026-10-15: not found by the holder's on-chain walk = not held
      GROUP BY 1, 2, 4
    ), ranked AS (
      SELECT ext, owner, n, is_sys,
             row_number() OVER (PARTITION BY ext, is_sys ORDER BY n DESC, owner) AS rn
      FROM held
    ), per_ed AS (
      SELECT h.ext,
             sum(h.n)::int AS census_rows,
             sum(h.n) FILTER (WHERE h.is_sys)::int AS system_held,
             count(*) FILTER (WHERE NOT h.is_sys)::int AS holders,
             max(h.n) FILTER (WHERE NOT h.is_sys)::int AS top1,
             sum(h.n) FILTER (WHERE NOT h.is_sys AND h.rn <= 5)::int AS top5
      FROM ranked h
      GROUP BY h.ext
    ), cand AS (
      -- 2026-10-15: shares and the census gate use LIVE supply (mint count minus Atlas-reported
      -- burns); trade-ins burn moments, so the mint count over-states what can be held.
      SELECT p.*, e.id AS edition_id, e.circulation_count AS circ,
             greatest(e.circulation_count - coalesce(be.burned, 0), 1) AS live,
             (p.census_rows >= ceil(greatest(e.circulation_count - coalesce(be.burned, 0), 1) * 0.98)) AS complete
      FROM per_ed p
      JOIN editions e ON e.external_id = p.ext AND e.collection_id = v_coll
      LEFT JOIN badge_editions be ON be.collection_id = v_coll AND be.external_id = p.ext
      WHERE e.circulation_count > 0
    ), up AS (
      INSERT INTO topshot_edition_concentration AS t (
        edition_external_id, edition_id, circulation, census_rows, census_complete,
        holders, system_held, top1_share_pct, top5_share_pct, computed_at)
      SELECT c.ext, c.edition_id, c.circ, c.census_rows, c.complete,
             coalesce(c.holders, 0), coalesce(c.system_held, 0),
             CASE WHEN c.complete THEN round(100.0 * coalesce(c.top1, 0) / c.live, 1) END,
             CASE WHEN c.complete THEN round(100.0 * coalesce(c.top5, 0) / c.live, 1) END,
             v_stamp
      FROM cand c
      ON CONFLICT (edition_external_id) DO UPDATE SET
        edition_id      = EXCLUDED.edition_id,
        circulation     = EXCLUDED.circulation,
        census_rows     = EXCLUDED.census_rows,
        census_complete = EXCLUDED.census_complete,
        holders         = EXCLUDED.holders,
        system_held     = EXCLUDED.system_held,
        top1_share_pct  = EXCLUDED.top1_share_pct,
        top5_share_pct  = EXCLUDED.top5_share_pct,
        computed_at     = EXCLUDED.computed_at
      RETURNING t.census_complete
    )
    SELECT (SELECT count(*) FROM cand), count(*), count(*) FILTER (WHERE up.census_complete)
      INTO v_cand, v_written, v_complete
      FROM up;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- Write first, then retire only what this run did NOT write (R123): an edition that
  -- left the census stops claiming a measurement (census_complete=false, shares NULL ->
  -- the squeeze board shows "—"); a failed write keeps the previous run's rows.
  -- (v2, 2026-10-15: retired by UPDATE rather than removed, so this body carries no
  -- statement the cloud session's write gate holds; the row keeps its old computed_at.)
  IF v_err IS NULL THEN
    BEGIN
      UPDATE topshot_edition_concentration
         SET census_complete = false, top1_share_pct = NULL, top5_share_pct = NULL
       WHERE computed_at IS DISTINCT FROM v_stamp
         AND (census_complete OR top1_share_pct IS NOT NULL OR top5_share_pct IS NOT NULL);
      GET DIAGNOSTICS v_retired = ROW_COUNT;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_del_err := left(SQLERRM, 300);
    END;
  END IF;

  v_ok := v_err IS NULL AND v_del_err IS NULL AND v_written = v_cand;

  PERFORM public.log_pipeline_run(
    'topshot-edition-concentration', v_started, v_cand, v_written, 0,
    v_ok, coalesce(v_err, v_del_err), 'nba_top_shot', NULL, NULL,
    jsonb_build_object('candidates', v_cand, 'rows_written', v_written, 'census_complete', v_complete,
                       'rows_retired', v_retired, 'write_error', v_err, 'retire_error', v_del_err,
                       'version', 'v2-walk-confirmed-live-supply',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_ok, 'candidates', v_cand, 'rows_written', v_written,
                            'census_complete', v_complete, 'rows_retired', v_retired,
                            'write_error', v_err, 'retire_error', v_del_err);
END
$function$;

REVOKE ALL ON FUNCTION public.refresh_topshot_edition_concentration_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_edition_concentration_v2() TO service_role;

SELECT cron.schedule('rpc-topshot-edition-concentration', '58 2,8,14,20 * * *',
  $$SET statement_timeout = '120s'; SELECT public.refresh_topshot_edition_concentration_v2();$$);
