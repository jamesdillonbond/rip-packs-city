-- 2026-09-24 (PT) — floor-drop insider alerts printed raw numeric floors:
-- "floor down 48.0% in 24h ($25.0000 → $13.0000)" on /analytics and the
-- Top Shot overview. Guarded splice on the LIVE body of detect_floor_drops
-- (prosrc md5 854e6cb8baede7b2fe711aa006c48556): the two format() calls
-- receive ROUND(x, 2); the evidence jsonb keeps the raw values. ACL untouched.
-- The ~300 stored rows were rewritten in place the same way (execute_sql,
-- regexp on the two text columns; evidence_jsonb untouched).
-- anon-exec: intentional — SPLICE of detect_floor_drops (service_role only); ACL untouched by CREATE OR REPLACE.
-- Revert: re-apply the previous defining migration of detect_floor_drops.
DO $$
DECLARE
  v_def text;
  v_a1 text := $a$    format('%s · %s · floor down %s%% in 24h ($%s → $%s)', player_name, set_name, drop_pct, prior_floor, now_floor),$a$;
  v_n1 text := $a$    format('%s · %s · floor down %s%% in 24h ($%s → $%s)', player_name, set_name, drop_pct, ROUND(prior_floor, 2), ROUND(now_floor, 2)),$a$;
  v_a2 text := $a$           player_name, drop_pct, sales_24h, prior_floor, now_floor),$a$;
  v_n2 text := $a$           player_name, drop_pct, sales_24h, ROUND(prior_floor, 2), ROUND(now_floor, 2)),$a$;
  v_c int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'detect_floor_drops';
  IF v_def IS NULL THEN RAISE EXCEPTION 'detect_floor_drops not found'; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
  IF v_c <> 1 THEN RAISE EXCEPTION 'title anchor found % times', v_c; END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2);
  IF v_c <> 1 THEN RAISE EXCEPTION 'summary anchor found % times', v_c; END IF;
  EXECUTE replace(replace(v_def, v_a1, v_n1), v_a2, v_n2);
END $$;
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'detect_floor_drops';
  IF position('ROUND(prior_floor, 2), ROUND(now_floor, 2)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'splice did not land';
  END IF;
END $$;
