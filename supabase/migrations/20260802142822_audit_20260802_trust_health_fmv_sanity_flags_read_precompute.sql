-- audit_20260802_trust_health_fmv_sanity_flags_read_precompute
-- Repoints the fmv_sanity_flags arm of v_rpc_trust_health at rpc_trust_health_precompute.
-- Guarded replace off pg_get_viewdef: RAISES if either anchor is not found exactly once.
-- REVERT: see the revert SQL emitted in the session report -- restore the inline subselect
--         ( SELECT count(*)::numeric AS count FROM v_fmv_sanity_flags) and the original
--         catches text, then re-assert security_invoker=on.

DO $mig$
DECLARE
  v_def         text;
  v_new         text;
  v_old_sub_re  text := '\( SELECT count\(\*\)::numeric AS count\s+FROM v_fmv_sanity_flags\) AS count';
  v_old_catch   text := 'impossible FMV (WAP > max sale, negative, etc.)';
  v_new_sub     text := 'COALESCE(( SELECT pre.value FROM pre WHERE pre.metric = ''fmv_sanity_flags''::text), 999::numeric) AS "coalesce"';
  v_new_catch   text;
  n_sub         int;
  n_catch       int;
BEGIN
  v_new_catch := $c$impossible FMV (WAP > max sale, negative, etc.). Fires only when a TopShot edition''s FMV is BOTH under 12% of its set median (set median >$100, >=4 priced peers, HIGH/MED confidence, >$50 gap) AND under 60% of that edition''s OWN 30d sales median on >=4 of its own priced sales with a >$50 gap -- the 2026-08-01 own-sales corroboration that killed the star-set false positive, since a genuinely cheap role player in an expensive set is honest intra-set dispersion, not a mispricing. PRECOMPUTED (2026-08-02): inline, this arm cost 22.5s COLD and 2.1s WARM (~80k buffers -- a per-edition LATERAL latest-FMV probe across 12,984 canonical TopShot editions, then a per-set median), which made it the single largest STRUCTURAL cost in this view and the only arm still expensive when warm. It pushed the whole view to 38-64s, past the service_role 30s statement_timeout, so /api/sentinel could not read this board AT ALL -- the monitor failed BLIND, because a timeout reads as "0 breaches". Its ~80k-buffer working set was also evicting the cheaper arms from cache on Micro (offer_edition_gap measured 7.4s cold vs 68ms warm), so removing it speeds up arms it does not touch. Now read from rpc_trust_health_precompute, refreshed 6-hourly by cron job rpc-trust-health-precompute-refresh (jobid 222, cron_heavy, 600s budget), and computed there by selecting v_fmv_sanity_flags ITSELF rather than a copy of its predicate, so the corroboration logic can never drift from what this arm reports. TRADE: up to 6h of staleness on a metric whose baseline is 0 and whose breach_at is 1 -- acceptable because an impossible-FMV condition persists until fixed rather than self-clearing within the window, and the alternative was a board nobody could read. A missing or >24h-old precompute row reports 999 and BREACHES rather than reading 0.$c$;

  v_def := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);

  SELECT count(*) INTO n_sub   FROM regexp_matches(v_def, v_old_sub_re, 'g');
  SELECT count(*) INTO n_catch FROM regexp_matches(v_def, regexp_replace(v_old_catch, '([().*+?\[\]{}|^$\\])', '\\\1', 'g'), 'g');

  IF n_sub <> 1 THEN
    RAISE EXCEPTION 'fmv_sanity_flags inline subselect anchor matched % times (expected 1) -- view shape changed, aborting', n_sub;
  END IF;
  IF n_catch <> 1 THEN
    RAISE EXCEPTION 'fmv_sanity_flags catches anchor matched % times (expected 1) -- view shape changed, aborting', n_catch;
  END IF;

  v_new := regexp_replace(v_def, v_old_sub_re, v_new_sub);
  v_new := replace(v_new, v_old_catch, v_new_catch);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'guarded replace produced an identical definition -- aborting';
  END IF;
  IF position('FROM v_fmv_sanity_flags)' in v_new) > 0 THEN
    RAISE EXCEPTION 'inline v_fmv_sanity_flags reference survived the replace -- aborting';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
END
$mig$;

-- CREATE OR REPLACE VIEW wipes reloptions -- re-assert the exact spelling the
-- check_public_security_invariants() invariant matches ('on', not 'true').
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);

REVOKE SELECT ON public.v_rpc_trust_health FROM anon, authenticated;