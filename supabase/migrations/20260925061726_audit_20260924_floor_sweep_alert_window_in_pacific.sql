-- 2026-09-24 (PT) — floor-sweep insider alerts stamped their burst window in
-- UTC ("Sep 25 04:29–04:48 UTC") on a surface every reader is a US collector on
-- and every other timestamp on the site renders in the reader's local zone.
-- The summary is a stored string rendered verbatim (InsiderSignals.tsx), so it
-- is formatted at write time in Pacific — the product's reporting zone.
--
-- Guarded splice on the LIVE body of detect_topshot_sweeps (prosrc md5
-- 4397e9eedd410e9001edcc7b8767455e at the time of writing): the one
-- to_char(...) window line is replaced; everything else is byte-identical.
-- ACL untouched ({postgres, service_role} EXECUTE); CREATE OR REPLACE via
-- pg_get_functiondef keeps it.
-- anon-exec: intentional — SNAPSHOT SPLICE of detect_topshot_sweeps, already REVOKEd from anon/authenticated/PUBLIC (20260712194000); the ACL is unchanged.
-- Revert: re-apply 20260802202000_audit_20260802_snapshot_detect_topshot_sweeps.sql.
DO $$
DECLARE
  v_def    text;
  v_anchor text := $a$           to_char(ranked.first_buy, 'Mon DD HH24:MI') || '–' || to_char(ranked.last_buy, 'HH24:MI UTC'),$a$;
  v_new    text := $a$           to_char(ranked.first_buy AT TIME ZONE 'America/Los_Angeles', 'Mon DD HH12:MI AM') || '–' || to_char(ranked.last_buy AT TIME ZONE 'America/Los_Angeles', 'HH12:MI AM PT'),$a$;
  v_n      int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'detect_topshot_sweeps';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'detect_topshot_sweeps not found';
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'detect_topshot_sweeps: expected the UTC window anchor exactly once, found %', v_n;
  END IF;
  EXECUTE replace(v_def, v_anchor, v_new);
END $$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'detect_topshot_sweeps';
  IF position('HH24:MI UTC' IN v_src) > 0 OR position('America/Los_Angeles' IN v_src) = 0 THEN
    RAISE EXCEPTION 'detect_topshot_sweeps: PT window not in the live body after splice';
  END IF;
END $$;
