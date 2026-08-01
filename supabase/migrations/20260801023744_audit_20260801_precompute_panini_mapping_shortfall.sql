-- audit_20260801_precompute_panini_mapping_shortfall
--
-- Adds leg 6 to rpc_trust_health_precompute_refresh(): the Panini serial sale-field
-- MAPPING shortfall -- rows where upstream DID send brought_at_price but our column
-- came out null. That is a defect WE own and can fix.
--
-- WHY PRECOMPUTED RATHER THAN INLINE IN THE VIEW. The aggregate costs ~605ms:
--
--   EXPLAIN (ANALYZE, BUFFERS) on v_panini_serial_sale_field_supply
--     Seq Scan on panini_card_serials  (rows=49,208)
--     Execution Time: 605.078 ms
--
-- v_rpc_trust_health is read on the ALERTING path and already carries 23 subqueries,
-- so inlining a 0.6s seq scan + jsonb extraction would slow every alert check for a
-- metric that changes at most every few hours. It goes through the existing precompute
-- path instead (refreshed 6-hourly by cron rpc-trust-health-precompute-refresh, 58 */6).
--
-- SCOPE -- this is deliberately NOT the upstream-outage signal. The 2026-07-29 outage
-- (upstream stopped sending brought_at_price at all) is pct_upstream_supplied in
-- v_panini_serial_sale_field_supply and has a different owner: a vendor conversation,
-- not a code fix. The two are split on purpose. See
-- 20260801013000_audit_20260801_panini_preserve_sale_fossils.sql, which made this
-- shortfall measure only rows with last_sale_preserved_at IS NULL -- without that,
-- the arm would read NEGATIVE once fossils exist.
--
-- Purely additive: a new metric key alongside the existing 5 legs, whose values were
-- verified identical after this ran (topshot_impossible_parallel_serials 0, and the
-- four *_fmv_pct_stale_30d unchanged at 32.2 / 0 / 0 / 96.1). Total 18.8s against a
-- 600s statement timeout.
--
-- Rebuilt from pg_get_functiondef via GUARDED replace(): every anchor is asserted
-- present (and the RETURN anchor asserted UNIQUE) so a whitespace miss ABORTS rather
-- than silently no-op'ing. Same technique as audit_20260728_fix_edition_integrity_flags_metric.
--
-- Applied to prod via Supabase MCP 2026-08-01 02:37:44Z; committed here for the record.
--
-- Revert: drop leg 6 (the v_short DECLARE, the SELECT/INSERT block, and the
-- 'panini_sale_field_mapping_shortfall' key from the RETURN) and re-apply. The
-- precompute row is then orphaned and harmless:
--   DELETE FROM public.rpc_trust_health_precompute
--    WHERE metric = 'panini_sale_field_mapping_shortfall';

DO $mig$
DECLARE
  d text;
  a_decl text := '  v_cov     jsonb;';
  n_decl text := '  v_cov     jsonb;
  v_short  numeric;';
  a_ret text := '  RETURN jsonb_build_object(
    ''topshot_impossible_parallel_serials'', v_serials,';
  n_ret text := '  -- Leg 6 (2026-08-01): Panini serial sale-field MAPPING shortfall -- rows where
  -- upstream DID send brought_at_price but our column is null. Measured at ~605ms
  -- inline (seq scan + jsonb extraction over ~49k serials), which is why it lives
  -- here and is read from the precompute table rather than computed in the view.
  -- This is deliberately NOT the upstream-outage signal; that is pct_upstream_supplied
  -- in v_panini_serial_sale_field_supply and has a different owner.
  t1 := clock_timestamp();
  SELECT COALESCE(max(v.mapping_shortfall), 0)::numeric INTO v_short
  FROM public.v_panini_serial_sale_field_supply v;

  INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
  VALUES (''panini_sale_field_mapping_shortfall'', v_short, now(),
          round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value,
        computed_at = EXCLUDED.computed_at,
        duration_ms = EXCLUDED.duration_ms;

  RETURN jsonb_build_object(
    ''panini_sale_field_mapping_shortfall'', v_short,
    ''topshot_impossible_parallel_serials'', v_serials,';
BEGIN
  SELECT pg_get_functiondef('public.rpc_trust_health_precompute_refresh()'::regprocedure) INTO d;

  IF position(a_decl in d) = 0 THEN RAISE EXCEPTION 'abort: DECLARE anchor not found'; END IF;
  IF position(a_ret  in d) = 0 THEN RAISE EXCEPTION 'abort: RETURN anchor not found'; END IF;
  IF (SELECT count(*) FROM regexp_matches(d, 'RETURN jsonb_build_object', 'g')) <> 1 THEN
    RAISE EXCEPTION 'abort: expected exactly one RETURN jsonb_build_object';
  END IF;

  d := replace(d, a_decl, n_decl);
  d := replace(d, a_ret,  n_ret);
  EXECUTE d;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.rpc_trust_health_precompute_refresh() FROM anon, authenticated;
