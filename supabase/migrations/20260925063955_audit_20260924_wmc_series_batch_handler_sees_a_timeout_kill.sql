-- 2026-09-24 (PT) — check_when_others_timeout_blind() flagged
-- backfill_wmc_series_batch (shipped 20260925062451 an hour earlier): its
-- record-and-exit handler was WHEN OTHERS, which PL/pgSQL does not enter on a
-- statement_timeout kill (57014), so a killed batch would log nothing and
-- the walk state would not advance (R118). Guarded one-line splice on the
-- LIVE body; everything else byte-identical. ACL unchanged.
-- anon-exec: intentional — SPLICE of backfill_wmc_series_batch, REVOKEd from PUBLIC/anon/authenticated in 20260925062451; ACL untouched.
-- Revert: re-apply 20260925062451 (the WHEN OTHERS form).
DO $$
DECLARE
  v_def text;
  v_a   text := '  EXCEPTION WHEN OTHERS THEN';
  v_n   text := '  EXCEPTION WHEN query_canceled OR OTHERS THEN  -- R118: named so a 57014 kill is recorded';
  v_c   int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'backfill_wmc_series_batch';
  IF v_def IS NULL THEN RAISE EXCEPTION 'backfill_wmc_series_batch not found'; END IF;
  IF position('query_canceled OR OTHERS' IN v_def) > 0 THEN
    RAISE NOTICE 'already fixed — no-op';
    RETURN;
  END IF;
  v_c := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
  IF v_c <> 1 THEN RAISE EXCEPTION 'handler anchor found % times', v_c; END IF;
  EXECUTE replace(v_def, v_a, v_n);
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.check_when_others_timeout_blind()) x
     WHERE x->>'function' = 'backfill_wmc_series_batch'
  ) THEN
    RAISE EXCEPTION 'backfill_wmc_series_batch still blind to query_canceled';
  END IF;
END $$;
