-- audit_20261111_candy_revival_arm_needs_ten_sales
--
-- WHY (Claude Code cloud, 2026-11-11 ~9:20 PM PT; handoff queue item 13). candy_revival_sales_since_recorded_silence
-- breached at ONE sale, and a Candy trickle -- 6 sales / ~$20 in four weeks (11-07 3, 11-08 1, 11-09 1, 11-11 1),
-- against 86-374 sales a DAY before the 10-12 lock -- forced two re-dates of v_collection_marketplace_status in two
-- days (20261110225146, 20261111211740). Each stray sale re-arms it, so the arm reads as noise.
--
-- Now it breaches at 10 sales since the recorded silent_since date. 10 is still an early signal of a REAL revival
-- (under one hour of pre-lock volume), while the observed trickle (~1.5 sales/week) would take ~6 weeks to reach it.
-- The 30-day re-verify clock in candy_sales_stale_hours still forces a human look monthly whatever this arm reads.
-- Only the breach_at literal and the arm's description change: the live definition (md5 asserted) with exactly one
-- fragment replaced, the old fragment asserted gone; security_invoker re-specified; no dependent views.
--
-- REVERT: the same DO block with old/new swapped (guard md5 = the post-change definition).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);
  o text := $o$1::numeric AS "numeric",
            'REVIVAL DETECTOR for a RECORDED Candy closure$o$;
  nw text := $n$10::numeric AS "numeric",
            'REVIVAL DETECTOR (FLOOR 10 since 2026-11-11: one stray sale no longer breaches; six trickle sales in four weeks forced two re-dates) for a RECORDED Candy closure$n$;
  n int;
BEGIN
  IF md5(d) <> '93fb04086265cc6f9d895ded2fbd14ad' THEN
    RAISE EXCEPTION 'v_rpc_trust_health drifted (md5 %); re-derive before replacing', md5(d);
  END IF;
  n := (length(d) - length(replace(d, o, ''))) / length(o);
  IF n <> 1 THEN RAISE EXCEPTION 'expected the Candy revival fragment exactly once, found %', n; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health WITH (security_invoker = on) AS ' || replace(d, o, nw);
  IF position(o in pg_get_viewdef('public.v_rpc_trust_health'::regclass, true)) > 0 THEN
    RAISE EXCEPTION 'v_rpc_trust_health was not rewritten';
  END IF;
END $$;
