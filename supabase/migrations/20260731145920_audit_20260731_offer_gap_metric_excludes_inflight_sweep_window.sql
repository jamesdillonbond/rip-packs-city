-- audit_20260731_offer_gap_metric_excludes_inflight_sweep_window
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260731145920, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. This is a LIVE change to what offer_edition_gap_max_usd pages
-- on. Depends on the two trailing columns added by
-- audit_20260731_offer_sanity_flags_surfacing_timestamps -- apply that first.
-- See docs/overnight/ledger.md 2026-07-31.
--
-- Revert: reverse the o/n and od/nd pairs below (swap each literal), re-run,
-- then restate security_invoker and the anon REVOKE.

DO $mig$
DECLARE
  d text;
  o text := 'FROM v_offer_sanity_flags f
                  WHERE f.has_sub_serial = false';
  n text := 'FROM v_offer_sanity_flags f
                  WHERE f.has_sub_serial = false AND (f.offers_refreshed_at > f.top_offer_created_at OR f.top_offer_created_at < (now() - ''02:00:00''::interval))';
  od text := 'edition-grain on-chain offer not surfaced in edition_offers (raise_edition_offers_from_chain / offers-sweep stalled)';
  nd text := 'edition-grain on-chain offer not surfaced in edition_offers (raise_edition_offers_from_chain / offers-sweep stalled). GRACE (2026-07-31): a gap counts only if offers-sweep has actually run for that edition since the offer landed (offers_refreshed_at > top_offer_created_at) OR the offer is older than 2h (6x the 20-min sweep cadence) -- the second arm is what still catches a fully stalled sweep, which the first arm alone would go blind to. Without this the metric read 178 with the sweep at 72/72 runs ok: all five flagged offers were 7-15 min old and had simply not been swept yet. Latency was being reported as a correctness defect';
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO d;

  IF (SELECT count(*) FROM regexp_matches(d, 'FROM v_offer_sanity_flags f', 'g')) <> 1 THEN
    RAISE EXCEPTION 'abort: expected exactly 1 v_offer_sanity_flags branch, found %',
      (SELECT count(*) FROM regexp_matches(d, 'FROM v_offer_sanity_flags f', 'g'));
  END IF;
  IF position(o in d) = 0 THEN
    RAISE EXCEPTION 'abort: offer-gap predicate not found verbatim -- view deparsed differently than expected';
  END IF;
  IF position(od in d) = 0 THEN
    RAISE EXCEPTION 'abort: offer-gap description not found verbatim';
  END IF;

  d := replace(d, o, n);
  d := replace(d, od, nd);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || d;
END
$mig$;

ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
REVOKE ALL ON public.v_rpc_trust_health FROM anon;
