-- audit_20261119_trust_health_null_reads_unknown_not_ok
--
-- 2026-11-19 ~4:30 PM PT (Claude Code cloud; Trevor: "Keep going and work through anything else
-- unresolved from this thread").
--
-- FINDING (same thread, 20261119153000). v_rpc_trust_health computes
--   status = CASE WHEN value >= breach_at THEN 'BREACH' ELSE 'ok' END
-- so a NULL value — an arm that MEASURED NOTHING — reads "ok". That is how
-- pack_ev_board_max_stale_days sat green while structurally unable to fire. Every consumer
-- (/api/sentinel `status !== 'ok'`, rpc_ops_snapshot `status <> 'ok'`) already treats anything
-- but 'ok' as a finding, so the honest third state needs only a third label.
--
-- FIX, two parts, one splice:
--   1. status: NULL -> 'UNKNOWN' (sorted with the breaches). An arm that cannot measure is
--      now a sentinel WARN, not a silent pass.
--   2. The one arm that is LEGITIMATELY NULL today had to stop being NULL first, or (1) would
--      warn forever: pack_ev_board_pct_depleted was a percentage of the ranked +EV board, and
--      that board is honestly EMPTY (0 rows at write time), so 0/0 = NULL. It becomes
--      pack_ev_board_depleted_ranked: the COUNT of ranked packs with depletion_pct >= 90,
--      breach_at 1. A count over an empty set is a real 0, not a fabricated one. Since the MV
--      already drops depletion_pct >= 90, it is a guard on that filter (fires only if the filter
--      is removed or bypassed); its catches text says so. No code reads the old name (grep:
--      only migrations).
--
-- Measured before: 0 arms BREACH, 1 arm NULL (pack_ev_board_pct_depleted). After: 0 BREACH,
-- 0 UNKNOWN expected.
--
-- md5-guarded text splice on the live view; security_invoker re-set.
-- REVERT: the same splice with each v_new/v_old pair swapped.

DO $do$
DECLARE
  v_def text := pg_get_viewdef('public.v_rpc_trust_health'::regclass);
  v_old1 text := 'round(((100.0 * (count(*) FILTER (WHERE (topshot_pack_reality_top_ev.depletion_pct >= 90)))::numeric) / (NULLIF(count(*), 0))::numeric), 0) AS pct_depleted';
  v_new1 text := '((count(*) FILTER (WHERE (topshot_pack_reality_top_ev.depletion_pct >= 90)))::numeric) AS pct_depleted';
  v_old2 text := 'SELECT ''pack_ev_board_pct_depleted''::text AS text,';
  v_new2 text := 'SELECT ''pack_ev_board_depleted_ranked''::text AS text,';
  v_old3 text := E'(30)::numeric AS "numeric",\n            ''depleted packs ranked as top EV. Reads the public board, whose MV already drops depletion_pct >= 90, so this is a GUARD ON THAT FILTER (it fires only if the filter is removed). NULL when the board is empty -- honest: no +EV pack passes the filters, so none is ranked depleted. Board freshness is pack_ev_board_max_stale_days (2026-11-19).''::text';
  v_new3 text := E'(1)::numeric AS "numeric",\n            ''depleted packs ranked as top EV: COUNT of packs on the public +EV board with depletion_pct >= 90 (was pack_ev_board_pct_depleted, a percentage that read NULL = ok on an honestly empty board; renamed 2026-11-19). The MV already drops depletion_pct >= 90, so this is a GUARD ON THAT FILTER: it fires only if the filter is removed or bypassed. 0 on an empty board is a real count. Board freshness is pack_ev_board_max_stale_days.''::text';
  v_old4 text := 'WHEN (value >= breach_at) THEN ''BREACH''::text';
  v_new4 text := 'WHEN (value IS NULL) THEN ''UNKNOWN''::text WHEN (value >= breach_at) THEN ''BREACH''::text';
  v_old5 text := 'WHEN (value >= breach_at) THEN 0';
  v_new5 text := 'WHEN ((value IS NULL) OR (value >= breach_at)) THEN 0';
BEGIN
  IF md5(v_def) <> 'c612f8770616f4bc5d55f4ace484e10a' THEN
    RAISE EXCEPTION 'v_rpc_trust_health changed since this splice was written';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     OR (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1
     OR (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3) <> 1
     OR (length(v_def) - length(replace(v_def, v_old4, ''))) / length(v_old4) <> 1
     OR (length(v_def) - length(replace(v_def, v_old5, ''))) / length(v_old5) <> 1 THEN
    RAISE EXCEPTION 'an anchor is not present exactly once';
  END IF;
  v_def := replace(replace(replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3), v_old4, v_new4), v_old5, v_new5);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_def;
  ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
END
$do$;
