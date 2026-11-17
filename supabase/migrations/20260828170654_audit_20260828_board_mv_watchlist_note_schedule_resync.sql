-- 2026-08-28 — resync board_mv_refresh_watchlist notes to the live pg_cron schedules.
-- Documentation-only correction to a config table; `note` has no functional reader.
-- Revert: UPDATE public.board_mv_refresh_watchlist w SET note = b.note
--         FROM public.audit_20260828_board_mv_watchlist_note_backup b
--         WHERE b.matview_name = w.matview_name;
--         DROP TABLE public.audit_20260828_board_mv_watchlist_note_backup;

CREATE TABLE IF NOT EXISTS public.audit_20260828_board_mv_watchlist_note_backup AS
SELECT matview_name, note, now() AS backed_up_at
  FROM public.board_mv_refresh_watchlist;

ALTER TABLE public.audit_20260828_board_mv_watchlist_note_backup
  ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.audit_20260828_board_mv_watchlist_note_backup IS
  'Revert source for audit_20260828_board_mv_watchlist_note_schedule_resync. '
  'Verbatim board_mv_refresh_watchlist.note values as of 2026-08-28. Safe to drop '
  'once the resynced notes are accepted. Named explicitly -- do not wildcard-drop '
  'audit_20260828_*.';

DO $resync$
DECLARE
  r            record;
  v_live       text;
  v_updated    int;
  v_total      int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('mv_topshot_market_index_daily',          'rpc-refresh-market-index-daily',    '7 */2 * * *',  '7 */6 * * *'),
      ('mv_topshot_perfect_mint_premiums_board', 'rpc-refresh-perfect-mint-premiums', '17 */2 * * *', '0 */2 * * *'),
      ('mv_topshot_pack_reality_stats',          'rpc-refresh-pack-reality-stats',    '12 */2 * * *', '30 */2 * * *'),
      ('mv_topshot_pack_reality_top_ev',         'rpc-refresh-pack-reality-top-ev',   '15 */2 * * *', '34 */2 * * *'),
      ('mv_topshot_pack_reality_dist',           'rpc-refresh-pack-reality-dist',     '27 */2 * * *', '42 */2 * * *')
    ) AS t(matview_name, jobname, old_sched, new_sched)
  LOOP
    SELECT j.schedule INTO v_live
      FROM cron.job j
     WHERE j.jobname = r.jobname AND j.active;

    IF v_live IS NULL THEN
      RAISE EXCEPTION 'no active pg_cron job named % -- refusing to document a schedule for a job that is not scheduled', r.jobname;
    END IF;

    IF v_live IS DISTINCT FROM r.new_sched THEN
      RAISE EXCEPTION 'live schedule for % is % but this migration would write % -- the scheduler moved again; re-derive before applying', r.jobname, v_live, r.new_sched;
    END IF;

    UPDATE public.board_mv_refresh_watchlist w
       SET note = replace(w.note, r.jobname || ' ' || r.old_sched, r.jobname || ' ' || r.new_sched)
     WHERE w.matview_name = r.matview_name
       AND w.note LIKE '%' || r.jobname || ' ' || r.old_sched || '%';

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'watchlist note for % did not carry the expected anchor "% %" (matched % rows) -- someone else may have corrected it; re-read before applying',
        r.matview_name, r.jobname, r.old_sched, v_updated;
    END IF;

    v_total := v_total + v_updated;
  END LOOP;

  IF v_total <> 5 THEN
    RAISE EXCEPTION 'expected 5 note resyncs, applied % -- rolling back', v_total;
  END IF;
END
$resync$;

DO $cadence$
DECLARE v_n int;
BEGIN
  UPDATE public.board_mv_refresh_watchlist
     SET note = replace(note,
                        '(2-hourly since 2026-08-09, was hourly',
                        '(6-hourly since 2026-08-15, was 2-hourly from 2026-08-09, was hourly')
   WHERE matview_name = 'mv_topshot_market_index_daily'
     AND note LIKE '%(2-hourly since 2026-08-09, was hourly%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'market-index cadence clause not found as expected (matched % rows) -- re-read the note before applying', v_n;
  END IF;
END
$cadence$;

UPDATE public.board_mv_refresh_watchlist
   SET note = note || ' ⚠ 2026-08-28: the "4 missed ticks" reading above is stale '
                   || 'arithmetic from the 2-hourly era. At 7 */6 ONE missed tick is '
                   || '~12h and already breaches breach_at 8, so this row is the '
                   || 'usual sole cause of a board_mv_refresh_stale_hours breach '
                   || '(measured 2026-08-28 17:00Z: this row 10.94h, the six siblings '
                   || '0.28-0.98h). Do NOT raise breach_at -- it only defers the next '
                   || 'crossing; the real residual is the 600s refresh cost (#27/#41).'
 WHERE matview_name = 'mv_topshot_market_index_daily'
   AND note NOT LIKE '%⚠ 2026-08-28: the "4 missed ticks" reading%';