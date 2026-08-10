-- audit_20260810_board_liveness_honest_sweep_decoupled
--
-- Fixes three defects in the public-board liveness instrument, measured 2026-08-10.
--
-- 1. THE PROBE WAS TIMING A QUERY THE PLANNER PRUNED. It ran `SELECT count(*) FROM <view>`,
--    which needs no output columns, so any join PG can prove non-duplicating is REMOVED before
--    execution. Measured on allday_scarcity_board: pruned plan cost 3,873 vs honest 42,826.
--    ⚠ The filed candidate fix -- `SELECT count(*) FROM (SELECT * FROM v) t` -- DOES NOT WORK
--    (measured 3,873.09, byte-identical to the bare count: PG flattens it). Nor does an
--    `OFFSET 0` optimization fence (3,873.98) -- the fence stops flattening but PG still strips
--    subquery output columns the outer aggregate never references. The form that DOES retain the
--    plan is a whole-row reference: `count(t.*)` -> 42,827.12. We select BOTH:
--      count(*)    -- the exact row count (count(t.*) would undercount an all-NULL row,
--                     since ROW(NULL,NULL) IS NULL is TRUE)
--      count(t.*)  -- referenced solely to force the join to survive into the plan
--
-- 2. THE PER-BOARD statement_timeout GUARD WAS INERT. The old body called
--    set_config('statement_timeout', ..., true) per board and its comment claimed this made a
--    pathological view "fail its own probe instead of timing out the whole refresher".
--    ⚠ MEASURED FALSE: candy_pack_ev_model ran 94,508 ms under a 5,000 ms cap. statement_timeout
--    is armed at the start of the TOP-LEVEL statement; a runtime SET inside a function cannot
--    re-arm it (the same finding already recorded for function-level SET). Worse, if it HAD
--    fired, the cancel poisons the surrounding transaction, so the sweep dies anyway rather than
--    degrading. The inert call and its false comment are removed. The real bound is the
--    between-boards soft deadline, which -- like every soft deadline -- CANNOT preempt a single
--    long board. Documented, not pretended.
--
-- 3. A TIMED-OUT PROBE WAS COUNTED AS EMPTY, NOT SLOW. `v_err IS NOT NULL -> n_empty` meant a
--    board that renders fine but slowly was reported as "renders a blank board". Now split by
--    SQLSTATE: 57014 (timeout) -> SLOW; any other error -> EMPTY. Each board contributes at
--    most 1 to each counter.
--
-- DECOUPLING (why there are two functions). The sweep's only caller was
-- rpc_trust_health_precompute_refresh's Leg 8 -- the LAST and most expensive leg of a single
-- 600s transaction that was killed at 600.0s on 08-09 12:58Z and 08-10 12:58Z, rolling back all
-- 18 metrics. The honest sweep is far more expensive than the pruned one (measured honest times
-- below), so dropping it into Leg 8 would have made that kill routine -- strictly worse than the
-- blindness it fixes. So:
--   public_board_liveness_sweep()  -- NEW. The honest sweep + state writer. Own pg_cron job,
--                                     own transaction. A kill here costs only these 2 metrics.
--   public_board_liveness_probe()  -- SAME SIGNATURE, now a cheap READ of the state table, so
--                                     Leg 8 goes ~86s -> ~0ms with NO edit to the 18-metric
--                                     function. Signature preserved deliberately: changing it
--                                     would have reset grants and made the no-arg call ambiguous.
-- Bonus: the read reports budget_exhausted=true when the newest sweep is older than 8h or the
-- sweep was partial, which the refresher already maps to 999 -> BREACH. That is the separately
-- queued "cheap honesty guard" (stale snapshot served as current), delivered here for free --
-- previously staleness was invisible until the generic 24h mapping in v_rpc_trust_health.
--
-- MEASURED honest vs pruned (ms), 2026-08-10, boards that will newly BREACH their max_ms:
--   candy_pack_ev_model              94,508 vs      13   (budget  3,000 -> 31x)
--   candy_pack_market                19,297 vs     125   (budget  3,000 ->  6.4x)
--   allday_scarcity_board           ~15,172 vs     120   (budget  8,300 ->  1.8x)
--   topshot_2025_rookie_cohort_stats  7,283 vs       5   (budget  3,000 ->  2.4x)
--   candy_secondary_board             6,549 vs       8   (budget  3,000 ->  2.2x)
--   panini_squeeze_board             >60,000 vs  1,000+  (budget  6,000 -> exceeded a 60s probe)
-- ⚠ The filed planner-cost ranking does NOT predict runtime: the two largest ratios in it
-- (441,780x panini_sale_feed_status, 355x cross_collection_cohort_stats) are 97 ms and 33 ms
-- honest -- runtime non-events -- while a mid-table 1,134x is the 94.5s worst board. Use
-- measured ms, never the cost ratio, to rank this work.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-public-board-liveness-sweep');
--   DROP FUNCTION public.public_board_liveness_sweep(integer);
--   -- then restore the prior public_board_liveness_probe(integer) body from
--   -- the migration that defined it (pruned count(*), inert set_config, err->empty).

-- ---------------------------------------------------------------------------
-- 1. The honest sweep (NEW).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_board_liveness_sweep(p_budget_ms integer DEFAULT 600000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r         record;
  v_reg     regclass;
  v_cnt     bigint;
  v_whole   bigint;
  v_t0      timestamptz := clock_timestamp();
  v_tv      timestamptz;
  v_ms      integer;
  v_err     text;
  v_sqlst   text;
  n_probed  integer := 0;
  n_empty   integer := 0;
  n_slow    integer := 0;
  n_active  integer;
  v_bust    boolean := false;
BEGIN
  SELECT count(*) INTO n_active FROM public.public_board_liveness_watchlist WHERE is_active;

  FOR r IN
    SELECT view_name, min_rows, max_ms
      FROM public.public_board_liveness_watchlist
     WHERE is_active
     ORDER BY view_name
  LOOP
    -- Soft deadline, checked BETWEEN boards only. It cannot preempt a single long board;
    -- one pathological view can overrun it (94.5s observed). That is accepted: the overrun
    -- is recorded as that board's honest elapsed_ms, which is the measurement we want.
    IF EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000 > p_budget_ms THEN
      v_bust := true;
      EXIT;
    END IF;

    v_cnt := NULL; v_ms := NULL; v_err := NULL; v_sqlst := NULL;
    v_reg := to_regclass('public.' || quote_ident(r.view_name));

    IF v_reg IS NULL THEN
      v_err := 'object not found in schema public';
    ELSE
      v_tv := clock_timestamp();
      BEGIN
        -- count(*) is the honest row count; count(t.*) exists ONLY to reference the whole
        -- row so the planner cannot remove the view's joins. Dropping it silently restores
        -- the false-green this migration fixes. Do not "simplify" it away.
        EXECUTE format('SELECT count(*), count(t.*) FROM %s t', v_reg) INTO v_cnt, v_whole;
        v_ms := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
      EXCEPTION WHEN OTHERS THEN
        v_ms    := round(EXTRACT(epoch FROM clock_timestamp() - v_tv) * 1000);
        v_sqlst := SQLSTATE;
        v_err   := left(SQLSTATE || ': ' || SQLERRM, 500);
      END;
    END IF;

    INSERT INTO public.public_board_liveness_state (view_name, row_count, elapsed_ms, err, checked_at)
    VALUES (r.view_name, v_cnt, v_ms, v_err, now())
    ON CONFLICT (view_name) DO UPDATE
      SET row_count  = EXCLUDED.row_count,
          elapsed_ms = EXCLUDED.elapsed_ms,
          err        = EXCLUDED.err,
          checked_at = EXCLUDED.checked_at;

    n_probed := n_probed + 1;

    -- A TIMEOUT is SLOW, not EMPTY: the board renders, it just renders too slowly. Any other
    -- error is EMPTY, because a view that throws and a view with no rows render the identical
    -- blank board to the fail-soft page.
    IF v_sqlst = '57014' THEN
      n_slow := n_slow + 1;
    ELSIF v_err IS NOT NULL THEN
      n_empty := n_empty + 1;
    ELSE
      IF COALESCE(v_cnt, -1) < r.min_rows      THEN n_empty := n_empty + 1; END IF;
      IF COALESCE(v_ms, 0)  > r.max_ms         THEN n_slow  := n_slow  + 1; END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'probed', n_probed,
    'active', n_active,
    'empty_or_error', n_empty,
    'slow', n_slow,
    'budget_exhausted', v_bust,
    'sweep_ms', round(EXTRACT(epoch FROM clock_timestamp() - v_t0) * 1000),
    'checked_at', now()
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.public_board_liveness_sweep(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.public_board_liveness_sweep(integer) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.public_board_liveness_sweep(integer) TO service_role;

COMMENT ON FUNCTION public.public_board_liveness_sweep(integer) IS
  'Honest liveness sweep over public_board_liveness_watchlist: times count(*),count(t.*) per '
  'board (the whole-row ref defeats planner join-removal) and writes public_board_liveness_state. '
  'Runs on its OWN pg_cron job/transaction so a kill costs only the 2 board arms, never the '
  'precompute''s 18 metrics. Read the result via public_board_liveness_probe().';

-- ---------------------------------------------------------------------------
-- 2. The reader (REPLACES the old sweeping probe; signature unchanged on purpose).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_board_liveness_probe(p_budget_ms integer DEFAULT 180000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Sweeps run every 6h. 8h means one missed sweep is tolerated and two are not.
  c_max_age_min constant integer := 480;
  n_active  integer;
  n_probed  integer := 0;
  n_empty   integer := 0;
  n_slow    integer := 0;
  v_newest  timestamptz;
  v_stale   boolean;
BEGIN
  -- p_budget_ms is retained ONLY to keep the signature (and therefore the grants and the
  -- existing no-arg call in rpc_trust_health_precompute_refresh Leg 8) unchanged. This
  -- function no longer sweeps; public_board_liveness_sweep() does, on its own schedule.
  PERFORM p_budget_ms;

  SELECT count(*) INTO n_active
    FROM public.public_board_liveness_watchlist WHERE is_active;

  SELECT max(s.checked_at) INTO v_newest
    FROM public.public_board_liveness_state s
    JOIN public.public_board_liveness_watchlist w USING (view_name)
   WHERE w.is_active;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE (s.err IS NOT NULL AND s.err NOT LIKE '57014%')
         OR (s.err IS NULL AND COALESCE(s.row_count, -1) < w.min_rows)),
    count(*) FILTER (
      WHERE (s.err LIKE '57014%')
         OR (s.err IS NULL AND COALESCE(s.elapsed_ms, 0) > w.max_ms))
    INTO n_probed, n_empty, n_slow
    FROM public.public_board_liveness_state s
    JOIN public.public_board_liveness_watchlist w USING (view_name)
   WHERE w.is_active
     AND s.checked_at > now() - make_interval(mins => c_max_age_min);

  -- A stale or partial sweep is INCONCLUSIVE, never green. The caller maps
  -- budget_exhausted -> 999 -> BREACH, so a dead sweep job is LOUD instead of silently
  -- re-serving its last good snapshot as if it were current.
  v_stale := v_newest IS NULL
          OR v_newest < now() - make_interval(mins => c_max_age_min)
          OR n_probed < n_active;

  RETURN jsonb_build_object(
    'probed', n_probed,
    'active', n_active,
    'empty_or_error', n_empty,
    'slow', n_slow,
    'budget_exhausted', v_stale,
    'source', 'public_board_liveness_state',
    'sweep_checked_at', v_newest,
    'sweep_age_min', CASE WHEN v_newest IS NULL THEN NULL
                          ELSE round(EXTRACT(epoch FROM now() - v_newest) / 60.0) END,
    'checked_at', now()
  );
END;
$function$;

COMMENT ON FUNCTION public.public_board_liveness_probe(integer) IS
  'READS the last public_board_liveness_sweep() result out of public_board_liveness_state and '
  'returns the same jsonb shape (so rpc_trust_health_precompute_refresh Leg 8 is unchanged and '
  'now costs ~0ms instead of ~86s). Reports budget_exhausted=true -- which Leg 8 maps to 999 -- '
  'when the newest sweep is older than 8h or covered fewer boards than are active. '
  'p_budget_ms is vestigial, kept so the signature and grants do not change.';

-- ---------------------------------------------------------------------------
-- 3. The sweep's own schedule (applied alongside this migration).
--      SELECT cron.schedule(
--        'rpc-public-board-liveness-sweep',
--        '28 */6 * * *',
--        $$SET statement_timeout='900s'; SELECT public.public_board_liveness_sweep(600000);$$);
--    :28 is a minute carrying no other fixed-minute pg_cron job, and lands 30 min BEFORE the
--    58 */6 precompute so Leg 8 always reads a fresh sweep. The SET prefix is load-bearing:
--    pg_cron as postgres inherits the 120s global budget, which an honest sweep exceeds.
-- ---------------------------------------------------------------------------
