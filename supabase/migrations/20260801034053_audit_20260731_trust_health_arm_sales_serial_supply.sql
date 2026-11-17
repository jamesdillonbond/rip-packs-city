-- Applied to prod 2026-07-31 PT via MCP; filed here for the on-disk revert path.
--
-- Adds a 25th arm to v_rpc_trust_health: sales serial-supply (worst collection).
-- Reads the PRECOMPUTED value (leg 7 of rpc_trust_health_precompute_refresh);
-- inline it costs ~12.4s. The precompute row is written BEFORE this arm exists,
-- because a missing row COALESCEs to 999 and would page immediately.
--
-- Spliced into the `raw` CTE via a guarded replace on a boundary proven unique
-- (delta == its own length). Arms 1-24 untouched. Re-asserts security_invoker=on,
-- which CREATE OR REPLACE VIEW drops.
--
-- Verified after apply: 25 arms, 0 breaching, new arm 0.747/5 = ok,
-- reloptions {security_invoker=on}, check_public_security_invariants() 0 rows,
-- rpc_ops_snapshot() ok.
--
-- Revert: recreate the view from the pre-change definition
--   (md5 be7a01e9aade8ba6930aa6fc6f2de65a, length 16728),
--   ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
--   DELETE FROM public.rpc_trust_health_precompute WHERE metric='sales_serial_supply_worst_pct';
DO $do$
DECLARE
  v_def      text;
  v_new      text;
  v_delta    int;
  v_boundary text := E'\n        )\n SELECT metric,';
  v_arm      text := $arm$
        UNION ALL
         SELECT 'sales_serial_supply_worst_pct'::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE (pre.metric = 'sales_serial_supply_worst_pct'::text)), (999)::numeric) AS "coalesce",
            (5)::numeric AS "numeric",
            'a sales writer silently dropping serial_number: the row lands with price, buyer, seller and edition intact but no serial, so serial-level FMV (serial_fmv_estimate), the special-serials board and jersey-match go blind while the indexer keeps reporting ok=true. Worst collection over sales ingested in the last 24h (>=200 rows, sold within 30d). Validated on 9 weeks of history: TopShot 0 breach-days in 64, AllDay would have breached 2026-07-16 -- 15 days before the 07-13 regression was found by hand. PRECOMPUTED (~12.4s inline) by cron rpc-trust-health-precompute-refresh; a precompute older than 24h reads 999 so a dead refresher breaches rather than going quiet'::text AS text$arm$;
BEGIN
  v_def := pg_get_viewdef('public.v_rpc_trust_health'::regclass);

  v_delta := length(v_def) - length(replace(v_def, v_boundary, ''));
  IF v_delta <> length(v_boundary) THEN
    RAISE EXCEPTION 'raw-CTE boundary not found exactly once (delta=% expected=%) - aborting',
      v_delta, length(v_boundary);
  END IF;

  IF position('sales_serial_supply_worst_pct' in v_def) > 0 THEN
    RAISE EXCEPTION 'arm already present - aborting';
  END IF;

  v_new := replace(v_def, v_boundary, v_arm || v_boundary);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
END
$do$;

ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
