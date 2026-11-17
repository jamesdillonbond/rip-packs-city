-- audit_20260903_pipeline_alerts_say_the_drain_stalled_instead_of_dropping_the_eta
--
-- Follow-up to audit_20260903_unmapped_backlog_growth_no_eta_from_a_stalled_drain. That
-- migration stopped the alert PUBLISHING a false ETA. This one stops it reading as healthy
-- in the resulting silence.
--
-- ⚠ THE RESIDUAL DEFECT. With `days_to_drain` NULL the detail sentence is dropped by the
-- existing COALESCE, so the alert now says only "Live inflow 1/24h vs outflow 1263/24h".
-- Read alone that says the pile is draining briskly — while the CURRENT rate is 10 rows per
-- 3h. Removing a false claim and leaving the reader to infer the same wrong thing from what
-- remains is not honesty; the three states are draining / stalled / never-flowed, and the
-- middle one has to be SAID.
--
-- ⛔ WHY THIS IS A SURGICAL REPLACE AND NOT A FULL BODY. get_pipeline_alerts_core is 12,231
-- characters and carries a dozen unrelated alert arms that are load-bearing. Restating all
-- of it to change four lines risks a transcription error in the alerting path, and the
-- function is not drift-pinned so nothing would catch one. Instead the exact prior fragment
-- is quoted below, the occurrence count is ASSERTED to be exactly 1 before the replacement
-- (a silent no-op replace is the recorded failure mode for scripted edits in this repo), and
-- the block RAISEs rather than proceeding if that does not hold.
--
-- REPLACED (verbatim, 101 chars):
--                   COALESCE('~' || (e->>'days_to_drain') || 'd to clear the actionable pile. ', '') ||
--
-- WITH: a CASE that reports the stall with both windows when `drain_stalled` is true, and is
-- otherwise byte-identical to the fragment above.
--
-- ⚠ `(e->>'drain_stalled')::boolean` is NULL for a payload written before the sibling
-- migration — `CASE WHEN NULL` takes the ELSE branch, so a stale cache degrades to exactly
-- the old behaviour rather than erroring.
--
-- ⚠ A first attempt failed on `column reference "oid" is ambiguous` (bare `oid` against the
-- pg_proc/pg_namespace join). It failed LOUDLY and changed nothing, which is the point of
-- doing the lookup inside a block that raises.
--
-- VERIFIED after apply: the arm renders "NO ETA: the drain has STALLED — 10 rows resolved in
-- the last 3h against 1263/24h..."; get_pipeline_alerts_core still returns its single info
-- alert through both it and the get_pipeline_alerts wrapper; anon EXECUTE false on both.
--
-- REVERT: run the same DO block with v_old and v_rep exchanged.

DO $do$
DECLARE
  v_def text;
  v_old text := $frag$                  COALESCE('~' || (e->>'days_to_drain') || 'd to clear the actionable pile. ', '') ||$frag$;
  v_rep text := $rep$                  CASE WHEN (e->>'drain_stalled')::boolean
                       THEN 'NO ETA: the drain has STALLED — ' || (e->>'outflow_3h') ||
                            ' rows resolved in the last 3h against ' || (e->>'outflow_24h') ||
                            '/24h, so the 24h rate is stale and an ETA divided by it would be wrong. '
                       ELSE COALESCE('~' || (e->>'days_to_drain') || 'd to clear the actionable pile. ', '')
                  END ||$rep$;
  v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pipeline_alerts_core';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core not found — refusing to guess';
  END IF;

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 occurrence of the ETA fragment, found % — the body has moved, re-derive before replacing', v_n;
  END IF;

  EXECUTE replace(v_def, v_old, v_rep);
END
$do$;
