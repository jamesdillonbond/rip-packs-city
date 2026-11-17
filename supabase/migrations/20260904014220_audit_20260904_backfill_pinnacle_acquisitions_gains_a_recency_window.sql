-- audit_20260904_backfill_pinnacle_acquisitions_gains_a_recency_window
--
-- pg_cron jobid 78 `rpc-backfill-pinnacle-acquisitions` (`17 */6 * * *`, owner postgres,
-- so it runs under the cluster-default 120 s — the function's own `SET
-- statement_timeout '90s'` is inert on this path, known-issues #43). Measured
-- 2026-09-04 (7 d): 28 runs, 23 ok with a MAX of 118 s, 5 killed at the 120 s wall
-- (inbox 2026-08-31T1425Z's "clipped" shape). And the work it is being killed for
-- is NOTHING: its whole candidate set — every wallet_moments_cache Pinnacle row
-- joined to its buyer's pinnacle_sales row — is 6,573 rows, and ALL 6,573 are
-- already in moment_acquisitions (0 new). Every tick re-scans the full join
-- (wallet_moments_cache is ~2.5 M rows) to insert zero rows, and a killed tick
-- wastes the whole 120 s.
--
-- Per known-issues #42's own ordering the lever is NOT a bigger ceiling: raising
-- 120 → 600 s would let a tick waste 600 s to insert nothing. The lever is to do
-- LESS per tick: the historical backfill is complete, so the ongoing job only needs
-- to see RECENT sales. A 14-day window on `ps.sold_at` (indexed) takes the same
-- statement from ~118 s to **297 ms / 15k buffers** (EXPLAIN ANALYZE 2026-09-04
-- 02:0xZ, 302 candidates, 0 new), and a 6-hourly tick with a 14-day window gives a
-- sale ~56 chances to be captured.
--
-- SEMANTICS PRESERVED, per the pin (supabase/tests/backfill_pinnacle_acquisitions.sql):
--   * only PRICED sales qualify; NO nft_id-scoped gate; the exact-case buyer join;
--     the derived tx_hash; idempotence resting ENTIRELY on ON CONFLICT. None of
--     that moves — the window is one extra predicate, NULL = unbounded (the pin's
--     fixtures use May/June sales and call with the default, so they see the old
--     behaviour byte-for-byte).
--   * ⚠ Signature: the new parameter makes `f(50000)` AMBIGUOUS against the old
--     `(integer)` overload if both exist, so the old signature is DROPPED first and
--     the ACL is re-stated (a DROP loses it). The cron command is re-pointed at
--     `(50000, 14)` so the WINDOW is a caller decision visible in `cron.job`, not a
--     default buried in the function — the same rule as the statement_timeout prefix.
--
-- anon-exec: backfill_pinnacle_acquisitions — service_role/postgres only; EXECUTE revoked from PUBLIC, anon, authenticated below.
--
-- REVERT: re-apply the body from
--   supabase/migrations/20260816003000_audit_20260816_snapshot_pinnacle_acquisition_backfills.sql
--   (DROP FUNCTION public.backfill_pinnacle_acquisitions(integer, integer) first),
--   re-state the grants, and `SELECT cron.alter_job(78, command => 'SELECT public.backfill_pinnacle_acquisitions(50000)')`.
--   Move the pin (test file + drift-guard registration) back with it.

DROP FUNCTION IF EXISTS public.backfill_pinnacle_acquisitions(integer);

CREATE OR REPLACE FUNCTION public.backfill_pinnacle_acquisitions(p_limit integer DEFAULT 50000, p_since_days integer DEFAULT NULL)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
BEGIN
  WITH candidates AS (
    SELECT ps.nft_id,
           wmc.wallet_address AS wallet,
           ps.sale_price_usd  AS buy_price,
           ps.sold_at         AS acquired_date,
           ps.seller_address,
           COALESCE(NULLIF(split_part(ps.id, '_', 1), ''), 'pinnacle_backfill:' || ps.nft_id) AS tx_hash
    FROM wallet_moments_cache wmc
    JOIN pinnacle_sales ps
      ON ps.nft_id = wmc.moment_id
     AND ps.buyer_address = wmc.wallet_address
    WHERE wmc.collection_id = v_pin
      AND ps.sale_price_usd > 0
      -- Recency window (2026-09-04). NULL = unbounded (the historical backfill);
      -- the cron passes 14 so a tick scans days of sales, not the whole join.
      AND (p_since_days IS NULL OR ps.sold_at > now() - make_interval(days => p_since_days))
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO moment_acquisitions (
      nft_id, wallet, buy_price, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      seller_address, transaction_hash, source, collection_id
    )
    SELECT
      nft_id, wallet, buy_price, acquired_date, 1,
      'marketplace', 'verified',
      seller_address, tx_hash,
      'pinnacle_sales_join_wmc', v_pin
    FROM candidates
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins INTO v_inserted;

  RETURN json_build_object('collection', 'disney_pinnacle', 'inserted', v_inserted);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.backfill_pinnacle_acquisitions(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_pinnacle_acquisitions(integer, integer) TO service_role;

SELECT cron.alter_job(78, command => 'SELECT public.backfill_pinnacle_acquisitions(50000, 14)');
