-- audit_20260810_reconcile_saved_wallet_stats_pass2_first_and_freshness_skip
--
-- Follow-up to 20260810160000 (same session). That migration made
-- `reconcile_all_saved_wallet_stats` a resumable PROCEDURE with per-wallet COMMIT,
-- and its first real run immediately earned its telemetry: it committed 4 of 21
-- wallets / 13 rows in 106.5s before the soft deadline and logged
-- `truncated: true` -- the first progress this job has EVER made (2 of 2 prior
-- scheduled attempts committed nothing at all). Two defects showed up in that run.
--
-- 1. `cache_updated_at` IS A "LAST CHANGED" STAMP, NOT A "LAST VERIFIED" STAMP,
--    AND THAT HAS BEEN MISREAD AS STALENESS BY EVERY REPORT SO FAR.
--    Measured immediately after the run: of the 99 saved_wallets rows, 21 read
--    older than 12h -- and ALL 21 are (wallet, collection) pairs where the wallet
--    holds nothing, where all three cached_* columns are ALREADY correctly
--    (0, NULL, NULL), so **0 rows were wrong on screen**. Pass 2 deliberately
--    skips a row that already holds the right values (its WHERE has
--    `cached_moment_count IS DISTINCT FROM 0 OR ...`), so those rows can never
--    advance their timestamp and sit "stale" forever while being correct.
--    => The "21 rows past 12h / p50 age 9.4h / max 33.5h" figures in
--    docs/overnight/inbox/2026-08-10T1430Z-*.md are measuring THE GUARD, not user-
--    visible staleness. Do not re-file them as a data-quality defect.
--
-- 2. THE STALEST-FIRST ORDERING WAS KEYED ON THOSE SAME PERPETUALLY-OLD ROWS,
--    so the sweep spent its whole budget on wallets picked by a timestamp that can
--    never move -- and would have picked the same ones again on every subsequent
--    run. A livelock dressed as a priority queue. (Verified: the run's "stalest"
--    wallet `0x35873ed90cebb570` was stalest only because of a zero-holding row.)
--
-- FIX --------------------------------------------------------------------------
-- * PASS 2 NOW RUNS FIRST AND UNGATED. It is a single UPDATE over ~99 rows with an
--   index probe into wmc -- O(saved_wallets), not O(moments) -- while pass 1 is the
--   expensive per-wallet aggregate. Gating the cheap, always-correct half behind
--   completion of the expensive half meant the ONE case that is genuinely wrong on
--   screen (a wallet that sold out of a collection keeps showing its old count
--   forever) was skipped by `IF NOT v_truncated` in exactly the saturated
--   conditions that cause the problem. Cheap work first, then spend what is left.
-- * PASS 1's work list now considers ONLY (wallet, collection) pairs that actually
--   HAVE wmc rows, both for the freshness filter and for the ordering -- so the
--   ordering reflects what pass 1 can actually fix.
-- * NEW `p_min_age_minutes` (default 360) skips wallets refreshed in the last 6h.
--   The opportunistic writer in `wallet-backfill-multicollection` already keeps
--   actively-walked wallets fresh, so without this the sweep burns its budget
--   re-doing wallets that were correct minutes ago and never reaches the ones only
--   this backstop can fix. Pass `p_min_age_minutes => 0` to force a full sweep.
--
-- UNCHANGED AND LOAD-BEARING (see 20260810160000 for the measurements)
--   * INVOKER rights, NO `SET` clause -- a SECURITY DEFINER procedure and a
--     procedure with a SET clause BOTH fail 2D000 on COMMIT. Do not add either.
--   * The pg_cron command stays the single statement `CALL ...;` -- a `SET ...;`
--     prefix makes it an implicit transaction block and COMMIT fails 2D000.
--   * No budget raise (refuted twice) and no schedule move: 13:33Z daily stands.
--     A saturated run now makes partial, durable progress and says so; a quiet run
--     completes the set (the 05:01Z one-off did all 21 in 37s).
--
-- REVERT ----------------------------------------------------------------------
--   Re-apply 20260810160000 verbatim (it is a CREATE OR REPLACE of the same
--   procedure name; the argument list changes, so also:
--   DROP PROCEDURE IF EXISTS public.reconcile_all_saved_wallet_stats(integer, integer, integer);)
-- -----------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS public.reconcile_all_saved_wallet_stats(integer, integer);

-- INVOKER rights, no SET clause -- mandatory for transaction control.
-- Every reference below is schema-qualified because of it.
CREATE OR REPLACE PROCEDURE public.reconcile_all_saved_wallet_stats(
  p_max_seconds     integer DEFAULT 100,
  p_max_wallets     integer DEFAULT 500,
  p_min_age_minutes integer DEFAULT 360
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_deadline   timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_max_seconds, 1));
  v_pairs      jsonb;
  v_total      integer := 0;
  v_wallets    integer := 0;
  v_refreshed  integer := 0;
  v_zeroed     integer := 0;
  v_truncated  boolean := false;
  v_oldest_h   numeric;
  i            integer;
BEGIN
  -- PASS 2 FIRST: zero the (wallet, collection) pairs pass 1 structurally cannot
  -- touch, because `aggregate_saved_wallet_stats` joins to its own GROUP BY and a
  -- pair with zero wmc rows matches nothing. Without this a wallet that sold out of
  -- a collection displays its old count indefinitely. Cheap (~99 rows, index
  -- probes), so it runs unconditionally and before the expensive loop.
  UPDATE public.saved_wallets sw
     SET cached_moment_count = 0,
         cached_fmv_usd      = NULL,
         cached_top_tier     = NULL,
         cache_updated_at    = NOW()
   WHERE sw.wallet_addr IS NOT NULL
     AND (sw.cached_moment_count IS DISTINCT FROM 0
          OR sw.cached_fmv_usd IS NOT NULL
          OR sw.cached_top_tier IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1
         FROM public.wallet_moments_cache w
        WHERE w.wallet_address = sw.wallet_addr
          AND w.collection_id  = sw.collection_id
     );
  GET DIAGNOSTICS v_zeroed = ROW_COUNT;
  COMMIT;

  -- PASS 1 work list: only pairs that HAVE holdings (the ones this pass can
  -- actually fix), only those past p_min_age_minutes, stalest first.
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('u', s.user_id, 'w', s.wallet_addr)
                     ORDER BY s.stalest ASC NULLS FIRST),
           '[]'::jsonb)
    INTO v_pairs
    FROM (
      SELECT sw.user_id, sw.wallet_addr, MIN(sw.cache_updated_at) AS stalest
        FROM public.saved_wallets sw
       WHERE sw.wallet_addr IS NOT NULL
         AND sw.user_id IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.wallet_moments_cache w
            WHERE w.wallet_address = sw.wallet_addr
              AND w.collection_id  = sw.collection_id
         )
       GROUP BY sw.user_id, sw.wallet_addr
      HAVING MIN(sw.cache_updated_at) IS NULL
          OR MIN(sw.cache_updated_at) < now() - make_interval(mins => GREATEST(p_min_age_minutes, 0))
    ) s;

  v_total := jsonb_array_length(v_pairs);

  FOR i IN 0 .. v_total - 1 LOOP
    -- Checked BETWEEN wallets only: it cannot preempt a single wallet that runs
    -- long on its own (measured 2026-08-10 -- one wallet can exceed 100s under
    -- disk-IO saturation). A kill then costs only that wallet; everything already
    -- committed stays committed.
    IF clock_timestamp() >= v_deadline OR v_wallets >= p_max_wallets THEN
      v_truncated := true;
      EXIT;
    END IF;

    v_refreshed := v_refreshed + COALESCE(
      public.aggregate_saved_wallet_stats(
        (v_pairs -> i ->> 'u')::uuid,
        (v_pairs -> i ->> 'w')
      ), 0);
    v_wallets := v_wallets + 1;

    COMMIT;  -- per-wallet durability
  END LOOP;

  -- Reported for context only. NOTE it reads high permanently by design: rows that
  -- are already correctly (0, NULL, NULL) are skipped by pass 2, so their stamp
  -- never advances. A high value here is NOT evidence of stale display data.
  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets
   WHERE wallet_addr IS NOT NULL;

  PERFORM public.log_pipeline_run(
    'reconcile-saved-wallet-stats',
    NOT v_truncated,
    jsonb_build_object(
      'wallets_done',      v_wallets,
      'wallets_total',     v_total,
      'fetched',           v_total,
      'truncated',         v_truncated,
      'upserted',          v_refreshed,
      'rows_zeroed',       v_zeroed,
      'oldest_cache_h',    v_oldest_h,
      'min_age_minutes',   p_min_age_minutes,
      'elapsed_ms',        ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_started)) * 1000),
      'error',             CASE WHEN v_truncated
                                THEN 'soft_deadline_reached_partial_sweep_committed'
                                ELSE NULL END
    )
  );
  COMMIT;
END;
$procedure$;

COMMENT ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer) IS
  'Convergence backstop for saved_wallets.cached_* display columns. Cheap pass 2 '
  '(zero the sold-out pairs) runs FIRST and ungated; the expensive per-wallet pass 1 '
  'then spends the remaining budget, stalest-first, skipping wallets refreshed within '
  'p_min_age_minutes and considering only pairs that actually hold moments. '
  'Per-wallet COMMIT, so a statement timeout costs at most the wallet in flight. '
  'statement_timeout does NOT re-arm per COMMIT (measured 2026-08-10): the whole CALL '
  'shares one budget, so the soft deadline -- not the COMMIT -- is what bounds it, and '
  'it cannot preempt a single long wallet. INVOKER-rights with no SET clause ON PURPOSE: '
  'a SECURITY DEFINER procedure or one carrying a SET clause cannot COMMIT at all (both '
  'measured 2026-08-10, error 2D000). Its pg_cron command MUST stay the single statement '
  '"CALL ...;" for the same reason. NOTE saved_wallets.cache_updated_at is a LAST-CHANGED '
  'stamp, not last-verified: correctly-zeroed rows are skipped and read permanently stale.';

REVOKE EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer) FROM anon, authenticated;
GRANT  EXECUTE ON PROCEDURE public.reconcile_all_saved_wallet_stats(integer, integer, integer) TO service_role;

-- Command unchanged from 20260810160000 (single statement, no SET prefix); the new
-- third argument takes its default.
SELECT cron.alter_job(
  259,
  command => 'CALL public.reconcile_all_saved_wallet_stats();'
);
