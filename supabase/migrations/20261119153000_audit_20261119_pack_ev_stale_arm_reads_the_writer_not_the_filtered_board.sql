-- audit_20261119_pack_ev_stale_arm_reads_the_writer_not_the_filtered_board
--
-- 2026-11-19 ~3:45 PM PT (Claude Code cloud; Trevor: "Keep going ... using your best judgement").
--
-- FINDING. v_rpc_trust_health.pack_ev_board_max_stale_days read NULL with status "ok". It took
-- max(age) over topshot_pack_reality_top_ev, whose MV (mv_topshot_pack_reality_top_ev) KEEPS ONLY
-- rows with snapshotted_at >= now() - 48h. So:
--   * the value can never exceed 2.0 days, and breach_at IS 2: the arm is unreachable by
--     construction (the 44-day stale board of 2026-06-05 that it was named for cannot recur on it);
--   * a STALLED pack-EV writer ages every row out of the 48h window, empties the board, and the
--     arm reads NULL — and the view's status is `value >= breach_at`, so NULL renders "ok".
--   The failure it exists to catch is precisely the state in which it reports health.
-- Measured at write time: the board holds 0 rows (honestly — 2 Top Shot packs are +EV in the
-- last 48h and both fail the board's price/depletion/coverage filters), while the writer is
-- healthy (newest Top Shot pack_ev_history row 0.02h old, 1,438 packs in pack_ev_latest).
--
-- FIX. Measure the WRITER, not the filtered board: days since the newest Top Shot row in
-- pack_ev_history. Index-only on idx_pack_ev_history_collection — 5 buffers / 0.2 ms
-- (pack_ev_latest, the obvious alternative, is a 2.9 s DISTINCT ON over 718k rows: too costly
-- for a sentinel read). No Top Shot history at all reports 999 and BREACHES — absence must not
-- read as health. breach_at stays 2 (the writer runs continuously; 2 days dead is a real stall).
--
-- NOT CHANGED, stated: pack_ev_board_pct_depleted keeps reading the board. It reads NULL on an
-- empty board, which here IS the honest state (no packs ranked => none ranked depleted), and the
-- MV's own `depletion_pct < 90` filter makes it 0 on any non-empty board — it is now a guard on
-- that filter, not a market measurement. Its `catches` text says so.
--
-- Text splice, md5-guarded on the live view; security_invoker re-set (CREATE OR REPLACE VIEW
-- resets reloptions).
--
-- REVERT: the same splice with v_new/v_old swapped for each pair below.

DO $do$
DECLARE
  v_def text := pg_get_viewdef('public.v_rpc_trust_health'::regclass);
  v_old1 text := 'SELECT max((EXTRACT(epoch FROM (now() - topshot_pack_reality_top_ev.snapshotted_at)) / (86400)::numeric)) AS max_stale_days,';
  v_new1 text := 'SELECT COALESCE(( SELECT (EXTRACT(epoch FROM (now() - max(h.snapshotted_at))) / (86400)::numeric) FROM pack_ev_history h WHERE (h.collection_id = ''95f28a17-224a-4025-96ad-adf8a4c63bfd''::uuid)), (999)::numeric) AS max_stale_days,';
  v_old2 text := '''stale pack-EV board (hit 44d on 2026-06-05)''::text';
  v_new2 text := '''stale pack-EV board (hit 44d on 2026-06-05). Since 2026-11-19: days since the NEWEST Top Shot pack_ev_history row (the WRITER), not max age over the public board -- that board keeps only <48h-old snapshots, so the old arm could never exceed 2.0 and read NULL (= ok) exactly when the writer stalled and emptied it. 999 when there is no Top Shot history. Index-only, ~5 buffers.''::text';
  v_old3 text := '''depleted packs ranked as top EV''::text';
  v_new3 text := '''depleted packs ranked as top EV. Reads the public board, whose MV already drops depletion_pct >= 90, so this is a GUARD ON THAT FILTER (it fires only if the filter is removed). NULL when the board is empty -- honest: no +EV pack passes the filters, so none is ranked depleted. Board freshness is pack_ev_board_max_stale_days (2026-11-19).''::text';
BEGIN
  IF md5(v_def) <> '538fbf5d05fa4b0a22b76913df57f610' THEN
    RAISE EXCEPTION 'v_rpc_trust_health changed since this splice was written';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     OR (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1
     OR (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3) <> 1 THEN
    RAISE EXCEPTION 'an anchor is not present exactly once';
  END IF;
  v_def := replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_def;
  ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
END
$do$;
