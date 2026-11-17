-- 2026-09-24 (PT) — floor-drop alerts on a TEAM moment (editions.player_name
-- NULL) rendered " ·  · floor down 81.0% in 24h ($1250.00 → $237.00)": a
-- subject-less alert (25 of ~300 stored rows). Guarded one-line splice on the
-- LIVE body of detect_floor_drops: the subject is
-- COALESCE(player_name, team_name, name) so a team moment is named by its
-- team; the set stays as is. ACL untouched. The stored subject-less rows were
-- renamed in place from their edition (execute_sql).
-- anon-exec: intentional — SPLICE of detect_floor_drops (service_role only); ACL untouched by CREATE OR REPLACE.
-- Revert: re-apply 20260925065017.
DO $$
DECLARE
  v_def text;
  v_a   text := '      rsc.sales_24h, e.player_name, e.set_name, e.tier';
  v_n   text := '      rsc.sales_24h, COALESCE(e.player_name, e.team_name, e.name) AS player_name, e.set_name, e.tier';
  v_c   int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'detect_floor_drops';
  IF v_def IS NULL THEN RAISE EXCEPTION 'detect_floor_drops not found'; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
  IF v_c <> 1 THEN RAISE EXCEPTION 'subject anchor found % times', v_c; END IF;
  EXECUTE replace(v_def, v_a, v_n);
END $$;
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'detect_floor_drops';
  IF position('COALESCE(e.player_name, e.team_name, e.name) AS player_name' IN v_src) = 0 THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
END $$;
