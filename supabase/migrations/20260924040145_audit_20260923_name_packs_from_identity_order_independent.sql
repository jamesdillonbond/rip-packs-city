-- 2026-09-23 · Name packs from what Dapper's index ALREADY told us.
--
-- FINDING (measured 2026-09-23 ~9:10 PM PT): since 2026-09-18 about half of all
-- new Top Shot rips carried dist_id NULL (3,037 of 5,390 on 09-23 alone; 0 of
-- 1,419 on 09-17), and 1,569 Top Shot secondary pack purchases carried
-- pack_dist_id NULL. For 4,853 of the 4,867 rips and 1,562 of the 1,569
-- purchases, pack_nft_identity ALREADY held the answer (Dapper searchPackNft,
-- dist_id set).
--
-- MECHANISM: the identity lane (20260919021500 / 20260919031500) writes
-- dist_id into pack_rips / pack_purchases only at COLLECT time and only for
-- the ids in that response (`pr.pack_nft_id = ANY (v_touched)`). Its top-up
-- queues only packs with NO identity row. The wallet-holdings sync names a
-- SEALED pack days before it is opened, so when the rip (or the resale) lands
-- later the identity row already exists: the top-up skips it, the collector
-- never sees it again, and nothing else writes the join. Order-dependent
-- write, one order covered.
--
-- FIX: an order-independent sweep, name_packs_from_identity(), run every 5 min.
-- Both candidate reads walk the existing partial indexes on the NULL rows
-- (idx_pack_rips_dist_unresolved, idx_pack_purchases_dist_unresolved), so the
-- cost is bounded by the unresolved backlog, not the tables. Rules copied from
-- the collector: only where still NULL (never overwrite), dist '0' is not a
-- dist, rips get a 'dapper_index' / 'high' attribution row. Purchases fall back
-- to the marketplace-history dist (Dapper's own per-sale nft.dist_id) when the
-- identity lane has not seen the pack.
-- Also re-queues every unresolved pack that has NO identity row and is older
-- than the lane's one-day top-up window, so those get asked once.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-name-packs-from-identity');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'name-packs-from-identity';
--   DROP FUNCTION public.run_name_packs_from_identity(); DROP FUNCTION public.name_packs_from_identity(integer);
--   Rows it named: pack_rips with a 'dapper_index' attribution attributed after
--   this migration's apply time (dist_id can be re-NULLed from that set);
--   purchases are not individually tagged (pack_rips_propagate_dist_trg writes
--   the same column from the same source).

CREATE OR REPLACE FUNCTION public.name_packs_from_identity(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 20000);
  v_rips int := 0;
  v_purch_identity int := 0;
  v_purch_history int := 0;
  v_rips_left int := 0;
  v_purch_left int := 0;
  v_ts uuid;
  v_ad uuid;
  v_gz uuid;
BEGIN
  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';

  -- 1. Rips (pack_rips_propagate_dist_trg carries each one into pack_purchases).
  WITH cand AS (
    SELECT pr.id, i.dist_id
    FROM public.pack_rips pr
    JOIN public.pack_nft_identity i
      ON i.collection_id = pr.collection_id AND i.pack_nft_id = pr.pack_nft_id
    WHERE pr.dist_id IS NULL
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
    ORDER BY pr.sealed_at DESC
    LIMIT v_limit
  ), named AS (
    UPDATE public.pack_rips pr
       SET dist_id = c.dist_id
      FROM cand c
     WHERE pr.id = c.id AND pr.dist_id IS NULL
    RETURNING pr.id, pr.dist_id
  ), attributed AS (
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence, n_editions)
    SELECT n.id, n.dist_id, 'dapper_index', 'high', NULL FROM named n
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_rips FROM named;

  -- 2. Purchases the rip trigger did not reach (resold packs never opened by us, etc.).
  WITH cand AS (
    SELECT pp.id, i.dist_id
    FROM public.pack_purchases pp
    JOIN public.pack_nft_identity i
      ON i.collection_id = pp.collection_id AND i.pack_nft_id = pp.pack_nft_id
    WHERE pp.pack_dist_id IS NULL
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
    ORDER BY pp.sealed_at DESC
    LIMIT v_limit
  ), upd AS (
    UPDATE public.pack_purchases pp SET pack_dist_id = c.dist_id
      FROM cand c WHERE pp.id = c.id AND pp.pack_dist_id IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_purch_identity FROM upd;

  -- 3. Fallback: Dapper's marketplace history carries nft.dist_id on every sale.
  WITH cand AS (
    SELECT pp.id,
           COALESCE(
             CASE WHEN pp.collection_id = v_ts THEN (SELECT h.dist_id FROM public.topshot_pack_sales_history h WHERE h.pack_nft_id = pp.pack_nft_id AND h.dist_id IS NOT NULL AND h.dist_id <> '0' LIMIT 1) END,
             CASE WHEN pp.collection_id = v_ad THEN (SELECT h.dist_id FROM public.allday_pack_sales_history h WHERE h.pack_nft_id = pp.pack_nft_id AND h.dist_id IS NOT NULL AND h.dist_id <> '0' LIMIT 1) END,
             CASE WHEN pp.collection_id = v_gz THEN (SELECT h.dist_id FROM public.golazos_pack_sales_history h WHERE h.pack_nft_id = pp.pack_nft_id AND h.dist_id IS NOT NULL AND h.dist_id <> '0' LIMIT 1) END
           ) AS dist_id
    FROM public.pack_purchases pp
    WHERE pp.pack_dist_id IS NULL
      AND pp.collection_id IN (v_ts, v_ad, v_gz)
    ORDER BY pp.sealed_at DESC
    LIMIT v_limit
  ), upd AS (
    UPDATE public.pack_purchases pp SET pack_dist_id = c.dist_id
      FROM cand c WHERE pp.id = c.id AND c.dist_id IS NOT NULL AND pp.pack_dist_id IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_purch_history FROM upd;

  SELECT count(*) INTO v_rips_left  FROM public.pack_rips      WHERE dist_id IS NULL AND collection_id IN (v_ts, v_ad);
  SELECT count(*) INTO v_purch_left FROM public.pack_purchases WHERE pack_dist_id IS NULL AND collection_id IN (v_ts, v_ad);

  RETURN jsonb_build_object(
    'rips_named', v_rips,
    'purchases_named_identity', v_purch_identity,
    'purchases_named_history', v_purch_history,
    'rips_still_null', v_rips_left,
    'purchases_still_null', v_purch_left
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.name_packs_from_identity(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.name_packs_from_identity(integer) TO service_role, postgres;

COMMENT ON FUNCTION public.name_packs_from_identity(integer) IS
  'Order-independent join of pack_nft_identity (Dapper searchPackNft) and marketplace-history dist_id into pack_rips.dist_id / pack_purchases.pack_dist_id where still NULL. pg_cron rpc-name-packs-from-identity every 5 min via run_name_packs_from_identity(). 2026-09-23.';

-- Logged wrapper for pg_cron (catches everything incl. a statement_timeout kill, R118).
CREATE OR REPLACE FUNCTION public.run_name_packs_from_identity()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v jsonb;
  v_err text;
BEGIN
  BEGIN
    v := public.name_packs_from_identity(5000);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    v_err := SQLERRM;
  END;
  PERFORM public.log_pipeline_run(
    'name-packs-from-identity', v_started,
    NULL,
    CASE WHEN v IS NULL THEN NULL ELSE (v->>'rips_named')::int + (v->>'purchases_named_identity')::int + (v->>'purchases_named_history')::int END,
    NULL, v_err IS NULL, v_err, NULL, NULL, NULL, COALESCE(v, '{}'::jsonb));
END;
$fn$;

REVOKE ALL ON FUNCTION public.run_name_packs_from_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_name_packs_from_identity() TO service_role, postgres;

-- Unresolved packs Dapper has never been asked about, beyond the lane's 1-day top-up.
INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
SELECT c.collection_id, c.pack_nft_id, max(c.at)
FROM (
  SELECT r.collection_id, r.pack_nft_id, r.sealed_at AS at
  FROM public.pack_rips r
  WHERE r.dist_id IS NULL
    AND r.collection_id IN (SELECT id FROM public.collections WHERE slug IN ('nba_top_shot','nfl_all_day'))
  UNION ALL
  SELECT pp.collection_id, pp.pack_nft_id, pp.sealed_at
  FROM public.pack_purchases pp
  WHERE pp.pack_dist_id IS NULL
    AND pp.collection_id IN (SELECT id FROM public.collections WHERE slug IN ('nba_top_shot','nfl_all_day'))
) c
WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                   WHERE pi.collection_id = c.collection_id AND pi.pack_nft_id = c.pack_nft_id)
GROUP BY c.collection_id, c.pack_nft_id
ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;

SELECT cron.schedule('rpc-name-packs-from-identity', '4-59/5 * * * *', 'SELECT public.run_name_packs_from_identity();');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('name-packs-from-identity', 30, 'medium', 'Seeded 2026-09-23: pg_cron every 5 min -> 6x silent.', 60)
ON CONFLICT (pipeline) DO NOTHING;
