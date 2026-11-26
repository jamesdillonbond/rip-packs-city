-- 2026-11-25 ~5:50 PM PT (Claude Code, attended) — retire pg_cron job 901 `rpc-portfolio-snapshot-packs`
-- into job 913 `rpc-wallet-pack-value-cache` (Trevor-approved 11-22; the scheduled laptop task for
-- 11-25 9:07 AM PT never ran, so this executes it).
--
-- Precondition read 11-25 5:45 PM PT: job 913 succeeded every hourly run since 11-23 (60–100 s);
-- job 901 succeeded every run; 11-24 and 11-25 snapshots 58/58 filled.
--
-- What changes: after its per-wallet loop, `refresh_wallet_pack_value_cache` fills TODAY's
-- `portfolio_snapshots` pack columns from the cache — an owner is filled only when EVERY one of
-- its saved Flow wallets has a cache row computed in the last 2 hours (the cache stores only
-- error-free reads), so a failed wallet leaves the owner NULL (unknown, retried next hour), never
-- a partial sum. Same sums as `portfolio_owner_pack_value` (capped_ask_usd / count /
-- capped_ask_count). Snapshots land at 07:01 UTC; the 07:16 UTC cache run refreshes every wallet
-- (all are > 50 min old) and fills them — 40 min earlier than job 901's first slot, and every
-- hour after rather than 5 slots.
-- `portfolio-snapshot-packs` keeps logging to pipeline_runs, only on hours with unfilled rows.
--
-- `fill_portfolio_snapshot_pack_values` is KEPT (manual fallback; no caller after this).
--
-- Revert:
--   SELECT cron.schedule('rpc-portfolio-snapshot-packs', '56 7,8,9,10,11 * * *',
--          'CALL public.fill_portfolio_snapshot_pack_values(100);');
--   and re-apply the body of 20261122170115_audit_20261122_wallet_pack_value_cache.sql
--   (refresh_wallet_pack_value_cache without the fill step).

CREATE OR REPLACE PROCEDURE public.refresh_wallet_pack_value_cache(IN p_budget_seconds integer DEFAULT 90)
LANGUAGE plpgsql
AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  w text;
  v jsonb;
  v_done integer := 0;
  v_failed integer := 0;
  v_left integer := 0;
  v_snap_started timestamptz;
  v_snap_candidates integer := 0;
  v_snap_filled integer := 0;
BEGIN
  FOR w IN
    SELECT s.addr
    FROM (SELECT DISTINCT lower(sw.wallet_addr) AS addr
          FROM public.saved_wallets sw
          WHERE sw.user_id IS NOT NULL AND sw.wallet_addr ~* '^0x[0-9a-f]{16}$') s
    LEFT JOIN public.wallet_pack_value_cache c ON c.wallet_addr = s.addr
    WHERE c.computed_at IS NULL OR c.computed_at < now() - interval '50 minutes'
    ORDER BY c.computed_at NULLS FIRST, s.addr
  LOOP
    IF clock_timestamp() - v_started > make_interval(secs => p_budget_seconds) THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;
    v := public.wallet_held_pack_value(w);
    IF v IS NULL OR v ? 'error' THEN
      v_failed := v_failed + 1;
    ELSE
      INSERT INTO public.wallet_pack_value_cache (wallet_addr, value, computed_at)
      VALUES (w, v, clock_timestamp())
      ON CONFLICT (wallet_addr) DO UPDATE SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at;
      v_done := v_done + 1;
    END IF;
    COMMIT;
  END LOOP;
  PERFORM public.log_pipeline_run('wallet-pack-value-cache', v_started, v_done + v_failed + v_left,
    v_done, v_failed, v_failed = 0, NULL, NULL, NULL, NULL,
    jsonb_build_object('filled', v_done, 'failed', v_failed, 'over_budget', v_left,
                       'seconds', round(extract(epoch FROM clock_timestamp() - v_started))));
  COMMIT;

  -- 11-25: today's portfolio snapshot pack columns, from the cache (was job 901).
  v_snap_started := clock_timestamp();
  SELECT count(*) INTO v_snap_candidates
    FROM public.portfolio_snapshots ps
   WHERE ps.snapshot_date = CURRENT_DATE AND ps.pack_low_ask_usd IS NULL;

  IF v_snap_candidates > 0 THEN
    WITH targets AS (
      SELECT ps.id, ps.owner_key
        FROM public.portfolio_snapshots ps
       WHERE ps.snapshot_date = CURRENT_DATE AND ps.pack_low_ask_usd IS NULL
    ), owner_wallets AS (
      SELECT DISTINCT sw.user_id::text AS owner_key, lower(sw.wallet_addr) AS addr
        FROM public.saved_wallets sw
       WHERE sw.wallet_addr ~* '^0x[0-9a-f]{16}$'
    ), agg AS (
      SELECT t.id,
             count(ow.addr) AS wallets,
             count(c.wallet_addr) FILTER (WHERE c.computed_at > now() - interval '2 hours'
                                            AND NOT (c.value ? 'error')) AS fresh,
             round(COALESCE(sum((c.value->>'capped_ask_usd')::numeric), 0), 2) AS low_ask,
             COALESCE(sum((c.value->>'count')::int), 0) AS held,
             COALESCE(sum((c.value->>'capped_ask_count')::int), 0) AS listed
        FROM targets t
        LEFT JOIN owner_wallets ow ON ow.owner_key = t.owner_key
        LEFT JOIN public.wallet_pack_value_cache c ON c.wallet_addr = ow.addr
       GROUP BY t.id
    )
    UPDATE public.portfolio_snapshots ps
       SET pack_low_ask_usd  = a.low_ask,
           pack_held_count   = a.held,
           pack_listed_count = a.listed
      FROM agg a
     WHERE ps.id = a.id
       AND a.fresh = a.wallets;
    GET DIAGNOSTICS v_snap_filled = ROW_COUNT;

    PERFORM public.log_pipeline_run('portfolio-snapshot-packs', v_snap_started, v_snap_candidates,
      v_snap_filled, v_snap_candidates - v_snap_filled, v_snap_filled = v_snap_candidates, NULL, NULL, NULL, NULL,
      jsonb_build_object('filled', v_snap_filled, 'unfilled', v_snap_candidates - v_snap_filled,
                         'source', 'wallet_pack_value_cache',
                         'seconds', round(extract(epoch FROM clock_timestamp() - v_snap_started))));
    COMMIT;
  END IF;
END
$$;

SELECT cron.unschedule('rpc-portfolio-snapshot-packs');
