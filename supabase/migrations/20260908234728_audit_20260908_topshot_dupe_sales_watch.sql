-- anon-exec: intentional — new SECURITY DEFINER monitor function; REVOKEd from PUBLIC/anon/authenticated below, service_role + pg_cron only (check_topshot_dupe_sales)
-- audit_20260908: the detector for known-issue #68 — the half of it that is NOT a schema change.
--
-- WHY THIS AND NOT A CONSTRAINT. #68 (33,000 duplicate Top Shot sales, drained earlier tonight) ran for
-- six weeks unnoticed for one reason: **nothing would ever have told us.** The unique index that should
-- have caught it, `idx_sales_tx_nft_sold (transaction_hash, nft_id, sold_at)`, contains the timestamp the
-- two writers disagree about, so it recorded ZERO violations while 33,000 duplicates accumulated; and
-- because the duplicate writer then DIED, no failure-rate arm could fire either. A silent defect with a
-- guard that reads healthy is the worst shape in this estate.
--
-- ⛔ THE OBVIOUS FIX WAS MEASURED AND IS WRONG AS FILED. The #68 filing said to re-cut the index without
-- `sold_at`, i.e. UNIQUE (transaction_hash, nft_id). **That would reject 1,607 legitimate rows.** The 2020
-- historical import reuses one placeholder `transaction_hash` across genuinely different sales of the same
-- moment: 1,521 such groups survive, ALL of them at different prices, **1,509 of them spanning more than
-- ten minutes and one spanning 100 days**, avg price ratio 2.4x. Those are real, separate sales.
--
-- ✅ THE KEY THAT DOES WORK, verified violation-free across EVERY partition after tonight's drain
-- (2020 · 2021 · 2022 · 2023 · 2024 · 2025 · 2026 all read 0):
--     UNIQUE (transaction_hash, nft_id, price_usd) WHERE transaction_hash IS NOT NULL
-- It catches the #68 class exactly (that is the key the drain deduped on) and tolerates the 2020 import
-- (those groups differ in price). **It is NOT created here, deliberately:** `sales` is partitioned across
-- `sales_2020`…`sales_2027`, so a unique index means a CONCURRENTLY build per partition then ATTACH —
-- a heavy IO job on the platform's largest table (3.2 M Top Shot rows alone) on an IO-throttled instance.
-- Every route writer inserts with a bare `.insert()` and a per-row error fallback, so the new index would
-- turn a duplicate into a logged skip rather than a crash — safe, but it deserves a session with eyes on
-- it, and there is NO active duplicate writer today. Recipe and evidence are recorded; this migration
-- buys the detection in the meantime, for ~0.1 % of the cost.
--
-- WHAT. Every 6 h, count Top Shot sale groups sharing (nft_id, transaction_hash, price_usd) in a 7-hour
-- window (1 h of overlap so nothing falls between runs) and log a `pipeline_runs` row whose **ok is FALSE
-- when the count is non-zero** — so the existing `failure_rate` arm of `get_pipeline_alerts()` surfaces it
-- with no change to that function. The watchlist row makes SILENCE visible too, which is the other way a
-- monitor dies.
--
-- COST, measured before shipping (this estate's rule: a guard must be cheaper than what it guards).
-- The 45-day window costs **75,473 buffers / 23,700 disk reads / 14.2 s** and spills to disk — refused.
-- The 7-hour window rides `sales_2026_collection_id_sold_at_idx` for **429 buffers / 48 ms**, 175x cheaper;
-- at 4 runs a day that is ~1,700 buffers/day total on an instance whose binding constraint is disk reads.
--
-- REVERT (a stranger can run this):
--   SELECT cron.unschedule('rpc-topshot-dupe-sales-watch');
--   DROP FUNCTION public.check_topshot_dupe_sales(int);
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-dupe-sales-watch';

CREATE OR REPLACE FUNCTION public.check_topshot_dupe_sales(p_hours int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_groups  int := 0;
  v_rows    int := 0;
  v_sample  jsonb;
  v_err     text;
BEGIN
  PERFORM set_config('statement_timeout', '60000', true);

  BEGIN
    SELECT count(*), COALESCE(sum(n), 0)
      INTO v_groups, v_rows
      FROM (SELECT count(*) n
              FROM public.sales s
             WHERE s.collection_id = v_ts
               AND s.transaction_hash IS NOT NULL
               AND s.sold_at > now() - make_interval(hours => p_hours)
             GROUP BY s.nft_id, s.transaction_hash, s.price_usd
            HAVING count(*) > 1) q;

    IF v_groups > 0 THEN
      SELECT jsonb_agg(x) INTO v_sample FROM (
        SELECT s.nft_id, left(s.transaction_hash, 12) AS tx, s.price_usd,
               count(*) AS n, array_agg(DISTINCT COALESCE(s.source, '(null)')) AS srcs
          FROM public.sales s
         WHERE s.collection_id = v_ts
           AND s.transaction_hash IS NOT NULL
           AND s.sold_at > now() - make_interval(hours => p_hours)
         GROUP BY s.nft_id, s.transaction_hash, s.price_usd
        HAVING count(*) > 1
         LIMIT 5) x;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- ok = FALSE on a non-zero count, so the failure_rate arm of get_pipeline_alerts() reports it
  -- without any edit to that function.
  PERFORM public.log_pipeline_run(
    'topshot-dupe-sales-watch', v_started, v_groups, 0, 0,
    (v_err IS NULL AND v_groups = 0),
    COALESCE(v_err, CASE WHEN v_groups > 0
      THEN v_groups || ' duplicate sale group(s) in the last ' || p_hours || 'h — known-issue #68 has a LIVE writer again; see extra.sample'
      END),
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('dupe_groups', v_groups, 'dupe_rows', v_rows, 'window_hours', p_hours,
                       'sample', v_sample, 'issue', 'known-issue #68', 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('dupe_groups', v_groups, 'dupe_rows', v_rows,
                            'window_hours', p_hours, 'sample', v_sample, 'error', v_err);
END $$;

REVOKE ALL ON FUNCTION public.check_topshot_dupe_sales(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_topshot_dupe_sales(int) TO service_role;

-- Minute 38 is unused by any hourly job (free-set read from cron.job 2026-09-08); hours 3/9/15/21 keep it
-- clear of the :48 trust-health legs and the 6-hourly FMV cluster.
SELECT cron.schedule('rpc-topshot-dupe-sales-watch', '38 3,9,15,21 * * *',
  $cron$ SELECT public.check_topshot_dupe_sales(7) $cron$);

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES ('topshot-dupe-sales-watch', 480, 1440, 'high', true,
        'pg_cron rpc-topshot-dupe-sales-watch every 6 h at :38 since 2026-09-08 (migration audit_20260908_topshot_dupe_sales_watch). Counts Top Shot sale groups sharing (nft_id, transaction_hash, price_usd) in a 7 h window and logs ok=FALSE when the count is non-zero, so the failure_rate arm reports it. rows_found = dupe_groups; a healthy run is rows_found 0 and ok=true. ⛔ A FAILING RUN MEANS A SECOND WRITER IS DUPLICATING SALES AGAIN (known-issue #68) — read extra.sample for the nft/tx/sources, and remember the unique index CANNOT catch this class because it is keyed on (transaction_hash, nft_id, sold_at) and the writers disagree about sold_at. The durable fix is UNIQUE (transaction_hash, nft_id, price_usd) WHERE transaction_hash IS NOT NULL, verified violation-free on every partition 2026-09-08 but NOT created (partitioned table, per-partition CONCURRENTLY build + ATTACH). ⚠ Do NOT widen the window: 45 days costs 75,473 buffers / 14 s, the 7 h window costs 429 buffers / 48 ms.')
ON CONFLICT (pipeline) DO NOTHING;