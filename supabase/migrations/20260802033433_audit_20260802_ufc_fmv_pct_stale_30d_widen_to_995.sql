-- audit_20260802_ufc_fmv_pct_stale_30d_widen_to_995
-- Applied to prod 2026-08-02 03:34 UTC / 2026-08-01 20:34 PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- Widen ufc_fmv_pct_stale_30d 98 -> 99.5 and correct its now-false `catches` text.
--
-- WHY (Trevor-confirmed via AskUserQuestion 2026-08-01): the metric read 96.1
-- against breach_at 98 -- 1.9pp of headroom -- so it would page on ordinary
-- drift. Flow UFC Strike trading ended PERMANENTLY on 2026-05-13 (Aptos
-- migration), so ~96% of priced UFC editions carrying a >30d-old latest FMV is
-- the honest state of a dead market, not a pipeline fault. The companion arm
-- ufc_fmv_stale_hours (10.4 vs 30) still watches the writers themselves, so a
-- genuine UFC FMV outage is still caught.
--
-- The threshold's own history is the argument for not eyeballing this again:
--   90 -> 101 (mathematically UNBREACHABLE -- a percentage cannot exceed 100)
--      -> 98 (2026-08-01) -> 99.5 (here).
-- The `catches` text still claimed "breach_at 90", false through two changes;
-- corrected in the same statement so the next auditor is not re-deriving it.
--
-- METHOD: this view has ~30 inline arms and is the platform's primary trust
-- board, so it is NOT retyped. The live definition is read with
-- pg_get_viewdef(), two anchored substitutions are applied, and the result is
-- fed back through CREATE OR REPLACE VIEW -- guaranteeing nothing except the
-- intended bytes can change. Both substitutions ASSERT they matched, so if the
-- view shape has since drifted this raises instead of silently rewriting the
-- monitor. Re-running is safe: the anchors no longer match once applied, and
-- the block raises rather than corrupting anything.
--
-- VERIFIED after apply: 31 metrics, 0 breaching, all other breach_at values
-- unchanged (topshot 50 / allday 25 / golazos 40 / pinnacle 25 / candy 25),
-- security_invoker=on re-asserted, check_public_security_invariants() = 0.
--
-- REVERT: run the same block with fixed_txt/stale_txt and the two numbers
-- swapped, i.e. substitute '99.5::numeric AS "numeric",' (UFC arm) back to
-- '98::numeric AS "numeric",'.

DO $mig$
DECLARE
  d        text;
  d0       text;
  stale_txt CONSTANT text :=
    'breach_at 90 is set above that floor so the metric catches further DETERIORATION rather than paging on the known-dead market.';
  fixed_txt CONSTANT text :=
    'breach_at 99.5 sits above that floor so the metric catches a REVIVAL-THEN-STALL rather than paging on the permanent 2026-05-13 Aptos-migration outage. Threshold history, because this one has been mis-set twice: 90 -> 101 (a percentage cannot exceed 100, so it was UNBREACHABLE) -> 98 on 2026-08-01 (only 1.9pp above the live 96.1, so it would page on ordinary drift) -> 99.5 on 2026-08-02, Trevor-confirmed. Do NOT raise it above 100. If UFC ever revives on Flow, re-base this DOWN to ~3x the new steady-state.';
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO d0;

  -- Already applied? Nothing to do.
  IF position(stale_txt IN d0) = 0
     AND d0 ~ '99\.5::numeric AS "numeric",\s+''COVERAGE leg \(baseline 72\.3%' THEN
    RAISE NOTICE 'ufc_fmv_pct_stale_30d already widened to 99.5; skipping';
    RETURN;
  END IF;

  -- 1) the threshold itself, anchored on the UFC arm's unique catches prefix
  d := regexp_replace(
         d0,
         '98::numeric AS "numeric",(\s+)''COVERAGE leg \(baseline 72\.3%',
         '99.5::numeric AS "numeric",\1''COVERAGE leg (baseline 72.3%'
       );
  IF d = d0 THEN
    RAISE EXCEPTION 'ufc breach_at anchor did not match -- view shape changed; aborting without touching the trust board';
  END IF;

  -- 2) the stale justification sentence
  IF position(stale_txt IN d) = 0 THEN
    RAISE EXCEPTION 'ufc catches-text anchor did not match; aborting';
  END IF;
  d := replace(d, stale_txt, fixed_txt);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || d;
END
$mig$;

-- CREATE OR REPLACE VIEW wipes reloptions -- re-assert the repo-wide posture.
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
