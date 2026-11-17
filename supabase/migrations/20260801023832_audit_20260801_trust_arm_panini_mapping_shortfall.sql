-- audit_20260801_trust_arm_panini_mapping_shortfall
--
-- Wires the Panini serial sale-field MAPPING shortfall into v_rpc_trust_health as a
-- 24th metric, reading the precompute table in the same shape as
-- topshot_impossible_parallel_serials. The precompute leg is added by its sibling
-- 20260801023744_audit_20260801_precompute_panini_mapping_shortfall.sql -- apply that FIRST,
-- or this arm reads no row and the pre CTE's COALESCE default (999) makes it breach.
--
-- WHAT IT CATCHES: rows where upstream DID send brought_at_price but our column came out
-- null -- a regression WE own. It reads 0 on every capture day since 2026-07-23, i.e. the
-- mapping is faithful (column_last_sale_usd == raw_supplied_sale_price exactly), so ANY
-- non-zero value is new and actionable. breach_at = 1.
--
-- WHAT IT IS NOT: the 2026-07-29 upstream outage (upstream stopped sending the field at
-- all). That is pct_upstream_supplied in v_panini_serial_sale_field_supply, it is a vendor
-- conversation rather than a code fix, and it would breach on arrival -- so it is
-- deliberately NOT wired here. Two different owners, two different signals.
--
-- FAILS LOUD IN BOTH DIRECTIONS: the view's pre CTE maps any precompute older than 24h to
-- 999, which is >= breach_at 1, so a DEAD refresher breaches rather than going quiet. (That
-- is an inherited property of the precompute path, not authored here -- but it is what makes
-- a precomputed arm safe to trust.)
--
-- POSITIVE-CONTROLLED before being trusted -- a metric that has never fired is a metric you
-- do not know about. In a DO block: set the precompute value to 1, read the view, RAISE to
-- abort. Result: value=1 status=BREACH. Rollback confirmed afterwards (value 0, status ok,
-- computed_at unchanged at 02:37:50Z).
--
-- Rebuilt from pg_get_viewdef via GUARDED replace() so the other 23 arms stay byte-identical:
-- aborts if the metric is already present, if the raw-CTE terminator is not unique, or if the
-- anchor is not found verbatim. security_invoker restated because CREATE OR REPLACE VIEW
-- wipes reloptions, and the anon revoke restated with it.
--
-- Verified after apply: 24 metrics, 0 breaching; new arm 0 / breach_at 1 / ok;
-- check_public_security_invariants() 0; has_table_privilege('anon', ..., 'SELECT') false.
--
-- Applied to prod via Supabase MCP 2026-08-01 02:38:32Z; committed here for the record.
--
-- Revert: drop the UNION ALL branch below from the view definition and re-apply (then
-- re-assert security_invoker + the anon revoke). Dropping the sibling precompute leg too
-- leaves an orphaned, harmless row -- see that migration's revert note.

DO $mig$
DECLARE
  d text;
  anchor text := '        )
 SELECT metric,';
  branch text := '        UNION ALL
         SELECT ''panini_sale_field_mapping_shortfall''::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = ''panini_sale_field_mapping_shortfall''::text), 999::numeric) AS "coalesce",
            1::numeric AS "numeric",
            ''OUR ingest dropped a Panini serial sale price that upstream DID send (raw.brought_at_price present, last_sale_usd null). This is NOT the upstream outage that began 2026-07-29 -- that one is pct_upstream_supplied in v_panini_serial_sale_field_supply and has a different owner entirely. Reads 0 on every capture day since 2026-07-23, i.e. the mapping is faithful and column_last_sale_usd equals raw_supplied_sale_price exactly; any non-zero value is a regression WE own and can fix. PRECOMPUTED (2026-08-01) because it costs ~605ms inline (seq scan + jsonb over ~49k serials); refreshed 6-hourly by cron rpc-trust-health-precompute-refresh, and a precompute older than 24h reads 999 so a dead refresher breaches rather than going quiet''::text AS text
        )
 SELECT metric,';
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO d;

  IF (SELECT count(*) FROM regexp_matches(d, 'panini_sale_field_mapping_shortfall', 'g')) <> 0 THEN
    RAISE EXCEPTION 'abort: metric already present';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(d, E'\\)\\n SELECT metric,', 'g')) <> 1 THEN
    RAISE EXCEPTION 'abort: raw-CTE terminator is not unique';
  END IF;
  IF position(anchor in d) = 0 THEN
    RAISE EXCEPTION 'abort: anchor not found verbatim';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || replace(d, anchor, branch);
END
$mig$;

ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
REVOKE ALL ON public.v_rpc_trust_health FROM anon;
