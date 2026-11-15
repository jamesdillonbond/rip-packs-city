-- 2026-11-14 (~7:40 PM PT, Claude Code cloud). Trevor (7:19 PM PT), on the open list: "Do all of these."
--
-- 1. PACK PULLS AND PINNACLE MINTS CARRY $0 ON THE MOMENT SIDE, ESTATE-WIDE (Trevor 5:19 PM PT: "Moments pulled
--    from packs should show a $0 cost in the moment P&L side of things since that cost should be recorded on the
--    opened packs side"). The trigger from 20261115013000 now also covers acquisition_method = 'mint' (Disney
--    Pinnacle: a pin is minted into the opener's wallet when the pack opens — public.backfill_pinnacle_mint_acquisitions
--    reads pinnacle_mint_events.to_wallet). The existing NULL rows (pack_pull ~1.15M, mint ~15k) are set to $0 by
--    public.zero_unpriced_pulls_batch_20261114(limit), run in batches; every row it touches is recorded first in
--    flowty_archive.unpriced_pulls_zeroed_20261114 (id), so the revert is one UPDATE back to NULL.
--
-- 2. A RECURRING LANE (every 2 h, 90 s budget — pg_cron as postgres is cut at ~120 s) so newly saved wallets — and new rows the cache-refresh / multicollection lanes write — get the
--    same provable fill as tonight's one-off (20261115031000): public.refresh_saved_wallet_acquisitions(budget)
--    runs public.backfill_acq_own_history_20261114 for every saved Flow wallet x {Top Shot, All Day, Golazos, UFC,
--    Pinnacle} that holds that collection, least-recently-filled first, inside a wall-clock budget, and logs to
--    pipeline_runs as 'saved-wallet-acquisition-fill'.
--
-- Revert:
--   SELECT cron.unschedule('rpc-saved-wallet-acquisition-fill');
--   DROP FUNCTION public.refresh_saved_wallet_acquisitions(int);
--   UPDATE moment_acquisitions m SET buy_price = NULL FROM flowty_archive.unpriced_pulls_zeroed_20261114 z
--     WHERE m.id = z.id;   -- (drop the trigger first, or it sets them straight back to 0)
--   then re-apply 20261115013000's trigger function body (pack_pull only).

CREATE OR REPLACE FUNCTION public.moment_acq_pack_pull_zero_cost() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  -- A moment pulled from a pack (Top Shot / All Day / Golazos pack_pull, Pinnacle mint) costs $0 on the moment
  -- side; the pack carries the cost (get_wallet_pack_history). Only an UNKNOWN price is filled — a recorded
  -- price is never overwritten.
  IF NEW.acquisition_method IN ('pack_pull', 'mint') AND NEW.buy_price IS NULL THEN
    NEW.buy_price := 0;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.moment_acq_pack_pull_zero_cost() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS flowty_archive.unpriced_pulls_zeroed_20261114 (id uuid PRIMARY KEY, method text NOT NULL,
  zeroed_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON flowty_archive.unpriced_pulls_zeroed_20261114 FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.zero_unpriced_pulls_batch_20261114(p_limit int)
RETURNS int LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE n int;
BEGIN
  WITH b AS (
    SELECT id, acquisition_method FROM moment_acquisitions
    WHERE acquisition_method IN ('pack_pull', 'mint') AND buy_price IS NULL
    LIMIT p_limit
  ), rec AS (
    INSERT INTO flowty_archive.unpriced_pulls_zeroed_20261114 (id, method)
    SELECT id, acquisition_method FROM b ON CONFLICT (id) DO NOTHING RETURNING id
  ), upd AS (
    UPDATE moment_acquisitions m SET buy_price = 0 FROM rec WHERE m.id = rec.id AND m.buy_price IS NULL RETURNING 1
  )
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.zero_unpriced_pulls_batch_20261114(int) FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.saved_wallet_acquisition_fill_state (
  wallet text NOT NULL, collection_id uuid NOT NULL, last_run_at timestamptz, last_result jsonb,
  PRIMARY KEY (wallet, collection_id));
REVOKE ALL ON public.saved_wallet_acquisition_fill_state FROM PUBLIC, anon, authenticated;
ALTER TABLE public.saved_wallet_acquisition_fill_state ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.refresh_saved_wallet_acquisitions(p_budget_seconds int DEFAULT 240)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  r record; j jsonb;
  n_pairs int := 0; n_a int := 0; n_b int := 0; n_c int := 0; n_err int := 0; v_last_err text;
BEGIN
  FOR r IN
    SELECT p.wallet, p.collection_id
    FROM (
      SELECT DISTINCT lower(sw.wallet_addr) AS wallet, c.id AS collection_id
      FROM saved_wallets sw
      CROSS JOIN collections c
      WHERE sw.wallet_addr ~* '^0x[0-9a-f]{16}$'
        AND c.slug IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'ufc_strike', 'disney_pinnacle')
    ) p
    LEFT JOIN saved_wallet_acquisition_fill_state s ON s.wallet = p.wallet AND s.collection_id = p.collection_id
    WHERE EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = p.wallet AND w.collection_id = p.collection_id)
    ORDER BY s.last_run_at NULLS FIRST
  LOOP
    EXIT WHEN clock_timestamp() - v_started > make_interval(secs => p_budget_seconds);
    BEGIN
      j := public.backfill_acq_own_history_20261114(r.wallet, r.collection_id);
      n_a := n_a + (j->>'a_buys')::int; n_b := n_b + (j->>'b_unknown_to_buy')::int; n_c := n_c + (j->>'c_pulls')::int;
    EXCEPTION WHEN OTHERS THEN
      n_err := n_err + 1; v_last_err := SQLERRM; j := jsonb_build_object('error', SQLERRM);
    END;
    INSERT INTO saved_wallet_acquisition_fill_state (wallet, collection_id, last_run_at, last_result)
    VALUES (r.wallet, r.collection_id, clock_timestamp(), j)
    ON CONFLICT (wallet, collection_id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_result = EXCLUDED.last_result;
    n_pairs := n_pairs + 1;
  END LOOP;
  RETURN jsonb_build_object('pairs', n_pairs, 'a_buys', n_a, 'b_unknown_to_buy', n_b, 'c_pulls', n_c,
    'errors', n_err, 'last_error', v_last_err,
    'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int);
END $$;
REVOKE ALL ON FUNCTION public.refresh_saved_wallet_acquisitions(int) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('rpc-saved-wallet-acquisition-fill', '41 */2 * * *', $cmd$
SELECT public.log_pipeline_run('saved-wallet-acquisition-fill', now(),
  (x.r->>'pairs')::int,
  (x.r->>'a_buys')::int + (x.r->>'b_unknown_to_buy')::int + (x.r->>'c_pulls')::int,
  0, (x.r->>'errors')::int = 0, x.r->>'last_error', NULL, NULL, NULL, x.r)
FROM (SELECT public.refresh_saved_wallet_acquisitions(90) AS r) x
$cmd$);
