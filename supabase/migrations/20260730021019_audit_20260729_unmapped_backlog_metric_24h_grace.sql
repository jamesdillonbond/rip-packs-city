-- unmapped_resolution_backlog_max: add a 24h grace period so the metric measures
-- FAILURE-TO-RESOLVE rather than normal pipeline latency.
--
-- WHY (measured 2026-07-29): the arm counted every unresolved priced sale in the
-- trailing 30d, INCLUDING rows sold minutes ago that the resolver had not yet had
-- a chance to touch. Fresh AllDay sales resolve at p50 6.6 min / p99 34 min, so a
-- high-volume day (283 arrivals on 07-29 vs 74 on 07-28) put its in-flight tail
-- into the metric and pushed it to 106 vs breach_at 100 while the resolver was
-- healthy (93/93 ok runs, 961 rows resolved/24h, 85-100% of fresh sales resolved).
-- A sentinel that fires on volume spikes gets ignored, which defeats the exact
-- WAF-stall class it exists to catch (AllDay undercounting ~16%, 2026-06-16).
--
-- 24h is 40x the p99 on-chain latency, so it cannot mask a resolver stall, and it
-- gives the slower wmc/wallet-walk path (Leg A, observed max 73h) a fair chance.
-- Chosen at the empirical knee: the metric reads 62 at 24h/36h/48h/72h alike, so
-- 24h is where in-flight ends and genuine residual begins. breach_at stays 100 --
-- this fixes the measurement, it does not loosen the alarm.
--
-- POSITIVE CONTROL (verified): a 1-day resolver stall would read 136 -> still
-- BREACHES, so detection is preserved. A metric reading "ok" after a fix proves
-- nothing without this check.
--
-- Rebuilt from pg_get_viewdef via GUARDED literal replace (aborts if either target
-- is not found exactly once) so the other 22 arms stay byte-identical.
--
-- REVERT: re-run this block with v_old_pred/v_new_pred (and the catches text)
-- swapped, to drop the `sold_at < now() - '24:00:00'` clause, then re-assert
-- ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
DO $mig$
DECLARE
  v_def      text;
  v_new      text;
  v_old_pred text := 'AND (us.sold_at > (now() - ''30 days''::interval)))';
  v_new_pred text := 'AND (us.sold_at > (now() - ''30 days''::interval)) AND (us.sold_at < (now() - ''24:00:00''::interval)))';
  v_old_desc text := 'so this signals NEW stalls not the historical floor';
  v_new_desc text := 'so this signals NEW stalls not the historical floor. GRACE PERIOD (2026-07-29): rows sold in the last 24h are excluded -- they are still in flight, not failures. Fresh sales resolve at p50 6.6min / p99 34min, so 24h is 40x p99 and cannot mask a stall, while giving the slower wmc/wallet-walk promote path (max observed 73h) a fair chance. Without it a high-volume day (283 arrivals vs 74) counted its own in-flight tail and breached at 106 with the resolver fully healthy';
  n_pred int;
  n_desc int;
BEGIN
  v_def := pg_get_viewdef('public.v_rpc_trust_health'::regclass);

  n_pred := (length(v_def) - length(replace(v_def, v_old_pred, ''))) / length(v_old_pred);
  n_desc := (length(v_def) - length(replace(v_def, v_old_desc, ''))) / length(v_old_desc);

  IF n_pred <> 1 THEN
    RAISE EXCEPTION 'guard: expected exactly 1 occurrence of the 30d sold_at predicate, found %. Aborting rather than silently no-op.', n_pred;
  END IF;
  IF n_desc <> 1 THEN
    RAISE EXCEPTION 'guard: expected exactly 1 occurrence of the catches text, found %. Aborting rather than silently no-op.', n_desc;
  END IF;

  v_new := replace(v_def, v_old_pred, v_new_pred);
  v_new := replace(v_new, v_old_desc, v_new_desc);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'guard: replacement produced an identical definition. Aborting.';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
END
$mig$;

-- CREATE OR REPLACE VIEW wipes reloptions -- re-assert (this has bitten twice).
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
