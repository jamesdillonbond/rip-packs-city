-- unmapped_resolution_backlog_max is BREACHING at exactly 100/100 (AllDay).
-- Diagnosed rather than nudged. The threshold is NOT the problem and is left alone;
-- only the `catches` text changes, so the metric keeps firing.
--
-- MEASURED (2026-08-01), AllDay, resolved_at IS NULL, price>0, excluding the
-- tx-collision class:
--   * 100 rows inside the 30d window  <- what the metric counts
--   * 29,598 rows AGED OUT past 30d   <- the "historical floor" the metric excludes
--     of which 21,667 are sale_source = 'v1_dapper'; oldest 2026-01-20
--   * all 100 in-window rows: nft_id present, serial_number NULL, ALL have been
--     attempted (last_onchain_attempt_at set), all attempted within 7d (13 within
--     48h, none within 24h), 92 v1_dapper / 8 v2_dapper, avg price $5.67, and
--     ZERO carry any recorded failure reason (resolution_hint is just
--     {nft_id, sale_source}).
--
-- THE FINDING: the metric excludes the historical floor by AGE (>30d), but that
-- floor is CONTINUOUSLY REPLENISHED — the permanently-unresolvable Dapper-V1 class
-- arrives at roughly 100 per 30 days, sits in the window for 30 days, then joins
-- the 29,598. Age-based exclusion is correct for a ONE-OFF historical tail (which
-- is what it was written for) and structurally wrong for an ONGOING failure class:
-- inflow x window has simply now crossed the threshold. It will sit at ~100
-- indefinitely, so raising breach_at only buys time until the next crossing.
--
-- THE REAL FIX (handed off, NOT done here — ingest-adjacent, CLAUDE.md says
-- propose don't autonomously retune): make the resolver RECORD why a row failed,
-- then exclude by REASON exactly as `sales_tx_hash_unique_collision` already is.
-- Today a permanent failure and a transient one are indistinguishable in the data.
-- Deliberately NOT done instead: excluding rows that are old-and-not-recently-
-- attempted, because that is precisely what a genuine resolver STALL also looks
-- like — it would mask the one thing this metric exists to catch.
DO $mig$
DECLARE
  src text; out_src text;
  needle CONSTANT text := 'so this signals NEW stalls not the historical floor.';
  addition CONSTANT text :=
    'so this signals NEW stalls not the historical floor. '
    'FINDING 2026-08-01 (metric BREACHED at 100/100, resolver HEALTHY at ~2.2k resolved/24h): the excluded floor is '
    'CONTINUOUSLY REPLENISHED, not historical. AllDay carries 29,598 aged-out permanently-unresolvable rows '
    '(21,667 v1_dapper, oldest 2026-01-20) and ~100 more arrive per 30d, all attempted, none carrying a failure '
    'reason. So the in-window count is this month cohort of a PERMANENT class, and age-based exclusion cannot '
    'separate it from a real stall. DO NOT raise breach_at -- it only defers the next crossing. The fix is to make '
    'the resolver record a permanent-failure reason and exclude by REASON (as sales_tx_hash_unique_collision '
    'already is). Until then this arm reads BREACH as an honest open finding.';
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO src;
  IF position(needle in src) = 0 THEN
    RAISE EXCEPTION 'catches anchor not found — aborting, nothing changed';
  END IF;
  IF position('FINDING 2026-08-01' in src) > 0 THEN
    RAISE NOTICE 'already recorded — skipping'; RETURN;
  END IF;
  out_src := replace(src, needle, addition);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || out_src;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;