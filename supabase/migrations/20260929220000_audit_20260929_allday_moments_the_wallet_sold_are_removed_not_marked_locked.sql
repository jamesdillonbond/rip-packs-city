-- 2026-09-29: an All Day moment the wallet SOLD is removed from wallet_moments_cache, not kept as "locked".
--
-- WHY. All Day has no per-NFT lock flag: a locked moment moves to Dapper custody and disappears from the
-- wallet's on-chain collection, so lib/allday-lock.ts marks EVERY cached moment absent on chain as
-- is_locked = true. A SOLD moment is absent on chain too, and nothing told the two apart: the lock diff
-- relabelled it "locked" every pass and it stayed in the wallet's holdings (portfolio value, counts) forever.
-- Measured 2026-09-29: 2,535 locked All Day rows across 22 wallets where the wallet ITSELF sold the moment
-- after we last saw it and never bought it back, going back to May; 161 of them from the last 2 days alone.
-- Chain spot check (4 rows): the seller holds none of them, the recorded buyer holds every one.
--
-- RULE (two independent confirmations, both AFTER the sale):
--   · sales: this wallet is the SELLER of the moment, sold_at > the row's last_seen_at, and no later sale
--     has this wallet as the BUYER;
--   · chain: a lock check ran after that sale (lock_checked_at > sold_at) and found it absent (is_locked).
-- A locked moment cannot be listed or sold, so a sale out is never a custody move.
--
-- prune_allday_wmc_sold_away(p_days):
--   p_days NULL → full history (one pass now; ~14 s, the sales hash). p_days N → sales of the last N days,
--   probed through wmc's (moment_id, collection_id) index (9.3k buffers, 0.67 s for 2 days, measured).
--   Daily at 11:37 UTC (4:37 AM PT) with 7 days, so a lock check that lags a few days is still covered.
-- Every deleted row is copied whole to allday_wmc_sold_away_pruned first.
--
-- Revert:
--   SELECT cron.unschedule('rpc-allday-wmc-sold-away-prune');
--   INSERT INTO public.wallet_moments_cache SELECT (p.row).* FROM public.allday_wmc_sold_away_pruned p
--     ON CONFLICT DO NOTHING;
--   DROP FUNCTION IF EXISTS public.prune_allday_wmc_sold_away(integer);

CREATE TABLE IF NOT EXISTS public.allday_wmc_sold_away_pruned (
  wmc_id    uuid PRIMARY KEY,
  row       public.wallet_moments_cache NOT NULL,
  sold_at   timestamptz NOT NULL,
  pruned_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.allday_wmc_sold_away_pruned ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.allday_wmc_sold_away_pruned FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.prune_allday_wmc_sold_away(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ad      constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_started timestamptz := clock_timestamp();
  v_found   int := 0;
  v_deleted int := 0;
  v_err     text;
BEGIN
  BEGIN
    DROP TABLE IF EXISTS _sold_away;
    IF p_days IS NULL THEN
      CREATE TEMP TABLE _sold_away ON COMMIT DROP AS
        SELECT w.id, s.sold_at
          FROM public.wallet_moments_cache w
          JOIN LATERAL (SELECT max(x.sold_at) AS sold_at FROM public.sales x
                         WHERE x.nft_id = w.moment_id AND x.collection_id = w.collection_id
                           AND lower(x.seller_address) = w.wallet_address
                           AND x.sold_at > w.last_seen_at) s ON s.sold_at IS NOT NULL
         WHERE w.collection_id = v_ad AND w.is_locked AND w.lock_checked_at > s.sold_at
           AND NOT EXISTS (SELECT 1 FROM public.sales b
                            WHERE b.nft_id = w.moment_id AND b.collection_id = w.collection_id
                              AND lower(b.buyer_address) = w.wallet_address AND b.sold_at > s.sold_at);
    ELSE
      CREATE TEMP TABLE _sold_away ON COMMIT DROP AS
        SELECT DISTINCT ON (w.id) w.id, s.sold_at
          FROM public.sales s
          JOIN public.wallet_moments_cache w
            ON w.moment_id = s.nft_id::text AND w.collection_id = s.collection_id
           AND w.wallet_address = lower(s.seller_address)
         WHERE s.collection_id = v_ad AND s.sold_at > now() - make_interval(days => p_days)
           AND w.is_locked AND s.sold_at > w.last_seen_at AND w.lock_checked_at > s.sold_at
           AND NOT EXISTS (SELECT 1 FROM public.sales b
                            WHERE b.nft_id = s.nft_id AND b.collection_id = s.collection_id
                              AND lower(b.buyer_address) = w.wallet_address AND b.sold_at > s.sold_at)
         ORDER BY w.id, s.sold_at DESC;
    END IF;
    SELECT count(*) INTO v_found FROM _sold_away;

    IF v_found > 0 THEN
      -- zzz_guard_del_wmc blocks a multi-wallet delete unless opted in; this one is evidence-scoped and audited.
      PERFORM set_config('rpc.allow_bulk_delete', 'on', true);
      WITH gone AS (
        DELETE FROM public.wallet_moments_cache w
         USING _sold_away a
         WHERE w.id = a.id AND w.collection_id = v_ad AND w.is_locked
        RETURNING w, a.sold_at
      ),
      logged AS (
        INSERT INTO public.allday_wmc_sold_away_pruned (wmc_id, row, sold_at)
        SELECT (g.w).id, g.w, g.sold_at FROM gone g
        ON CONFLICT (wmc_id) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int INTO v_deleted FROM logged;
      PERFORM set_config('rpc.allow_bulk_delete', 'off', true);
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'allday-wmc-sold-away-prune', v_started, v_found, v_deleted, GREATEST(v_found - v_deleted, 0),
    v_err IS NULL, v_err, 'nfl_all_day', NULL, NULL,
    jsonb_build_object('found', v_found, 'deleted', v_deleted, 'window_days', p_days, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('found', v_found, 'deleted', v_deleted, 'window_days', p_days, 'error', v_err);
END
$fn$;

COMMENT ON FUNCTION public.prune_allday_wmc_sold_away(integer) IS
  'Deletes All Day wallet_moments_cache rows the wallet SOLD (sales: seller = wallet after last_seen, no '
  'later buy back) that a lock check after the sale found absent on chain. The All Day lock diff cannot '
  'tell sold from locked (both are absent on chain) and kept sold moments as locked holdings. p_days NULL '
  '= full history, else the last N days of sales. Deleted rows copied to allday_wmc_sold_away_pruned.';

REVOKE ALL ON FUNCTION public.prune_allday_wmc_sold_away(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_allday_wmc_sold_away(integer) TO postgres, service_role;

-- The one full-history pass.
SELECT public.prune_allday_wmc_sold_away(NULL);

SELECT cron.schedule('rpc-allday-wmc-sold-away-prune', '37 11 * * *', 'SELECT public.prune_allday_wmc_sold_away(7)');
