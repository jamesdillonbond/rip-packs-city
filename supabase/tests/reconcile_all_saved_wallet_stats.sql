-- DB invariant: public.reconcile_all_saved_wallet_stats — the hourly sweep
-- (`rpc-reconcile-saved-wallet-stats`, `44 * * * *`) that refreshes the cached portfolio
-- figures a collector sees against their own saved wallets.
--
-- Unpinned until 2026-08-16 for TWO reasons, both worth knowing:
--   * it is NOT SECURITY DEFINER, so a SECDEF-scoped sweep of scheduled writers missed it;
--   * its only committed migration was STALE — a zero-argument FUNCTION, where live is a
--     PROCEDURE with three arguments, a soft deadline and per-wallet COMMITs. That drift
--     was invisible to `npm run db:pins:check`, which only reads functions already in the
--     PINS array. supabase/migrations/20260816181600_audit_20260816_snapshot_reconcile_
--     all_saved_wallet_stats.sql captures the live body so the checker can watch it.
--
-- ⚠ THIS FILE DOES NOT USE THE SUITE'S USUAL BEGIN/ROLLBACK ISOLATION, AND CANNOT.
-- The procedure COMMITs (per wallet, deliberately, so a long sweep's progress survives a
-- later failure). A COMMIT inside an explicit transaction block raises 2D000, so wrapping
-- it the normal way would test nothing but the error. Instead the whole test runs in a
-- THROWAWAY DATABASE created and dropped here. That keeps the isolation guarantee that
-- matters — the shared `public` schema every other test file builds fixtures in is never
-- touched — while letting the COMMITs actually happen. If this file fails midway the only
-- residue is an unused database, which collides with nothing; the DROP ... IF EXISTS at
-- the top makes a re-run clean.
--
-- The DDL below is VERBATIM from that snapshot migration.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

DROP DATABASE IF EXISTS rpc_dbtest_reconcile;
CREATE DATABASE rpc_dbtest_reconcile;
\c rpc_dbtest_reconcile

-- _helpers.sql was loaded into the ORIGINAL database, so re-create the assertions here.
CREATE OR REPLACE FUNCTION _assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'ASSERT FAILED: %', msg; END IF;
END $$;
CREATE OR REPLACE FUNCTION _assert_eq(actual text, expected text, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'ASSERT FAILED: % — got [%], want [%]', msg, actual, expected;
  END IF;
END $$;

CREATE TABLE public.saved_wallets (
  user_id             uuid,
  wallet_addr         text,
  collection_id       uuid,
  cached_moment_count integer,
  cached_fmv_usd      numeric,
  cached_top_tier     text,
  cache_updated_at    timestamptz
);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text,
  collection_id  uuid
);

-- Records which wallets the sweep actually asked to refresh, and in what order.
CREATE TABLE public._refreshed (seq serial, user_id uuid, wallet_addr text);
CREATE FUNCTION public.aggregate_saved_wallet_stats(p_user uuid, p_wallet text) RETURNS integer
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public._refreshed (user_id, wallet_addr) VALUES (p_user, p_wallet);
  UPDATE public.saved_wallets SET cached_moment_count = 7, cached_fmv_usd = 70.00,
         cached_top_tier = 'RARE', cache_updated_at = now()
   WHERE wallet_addr = p_wallet;
  RETURN 1;
END $$;

CREATE TABLE public._runs (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p text, p_ok boolean, p_extra jsonb) RETURNS void
LANGUAGE sql AS $$ INSERT INTO public._runs VALUES (p, p_ok, p_extra) $$;

-- >>> BEGIN verbatim reconcile_all_saved_wallet_stats (byte-identical to the migration/prod) >>>
CREATE OR REPLACE PROCEDURE public.reconcile_all_saved_wallet_stats(IN p_max_seconds integer DEFAULT 50, IN p_max_wallets integer DEFAULT 500, IN p_min_age_minutes integer DEFAULT 360)
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

    COMMIT;
  END LOOP;

  SELECT ROUND(EXTRACT(epoch FROM (now() - MIN(cache_updated_at))) / 3600.0, 1)
    INTO v_oldest_h
    FROM public.saved_wallets
   WHERE wallet_addr IS NOT NULL;

  -- ⚠ The 3-arg log_pipeline_run(text, boolean, jsonb) overload passes
  -- `p_started_at := now()`. now() is TRANSACTION START, and this procedure COMMITs
  -- per wallet, so by the time it logs, now() is the start of the tiny post-COMMIT
  -- transaction -- NOT the start of the sweep. duration_ms is a GENERATED column
  -- (finished_at - started_at), so it recorded the few ms since the last COMMIT.
  -- Measured 2026-08-26: avg elapsed 27,370 ms recorded as 10 ms, worst 114,748 ms
  -- recorded as 37 ms -- understated 2,688x. The named-arg form below passes the
  -- real v_started (clock_timestamp() at procedure entry).
  -- ⚠ Every other value is IDENTICAL to what the 3-arg overload derived, so nothing
  -- that reads pipeline_runs or extra changes: it mapped p_rows_found from
  -- extra->>'fetched' (= v_total), p_rows_written from extra->>'upserted'
  -- (= v_refreshed), p_rows_skipped from a key this caller never set (= 0), and
  -- p_error from extra->>'error'. The extra jsonb below is byte-identical.
  -- ⛔ Do NOT "fix" this in the 3-arg overload itself -- 14 other callers use it and
  -- they are all non-COMMITting FUNCTIONS, where now() IS their true start.
  PERFORM public.log_pipeline_run(
    p_pipeline     := 'reconcile-saved-wallet-stats',
    p_started_at   := v_started,
    p_rows_found   := v_total,
    p_rows_written := v_refreshed,
    p_rows_skipped := 0,
    p_ok           := NOT v_truncated,
    p_error        := CASE WHEN v_truncated
                           THEN 'soft_deadline_reached_partial_sweep_committed'
                           ELSE NULL END,
    p_extra        := jsonb_build_object(
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
-- <<< END verbatim reconcile_all_saved_wallet_stats <<<

-- ── Fixture ─────────────────────────────────────────────────────────────────
INSERT INTO public.saved_wallets VALUES
  -- stale (never refreshed) AND holds moments -> must be refreshed, and FIRST
  ('11111111-1111-1111-1111-111111111111','0xnever','aaaaaaaa-0000-0000-0000-000000000001',
   NULL, NULL, NULL, NULL),
  -- stale by 10h (default gate is 360 min) and holds moments -> refreshed, second
  ('22222222-2222-2222-2222-222222222222','0xstale','aaaaaaaa-0000-0000-0000-000000000001',
   1, 1.00, 'COMMON', now() - interval '10 hours'),
  -- refreshed 5 minutes ago -> INSIDE the gate, must be left alone
  ('33333333-3333-3333-3333-333333333333','0xfresh','aaaaaaaa-0000-0000-0000-000000000001',
   2, 2.00, 'COMMON', now() - interval '5 minutes'),
  -- holds NO moments any more, but still carries cached figures -> the zero pass
  ('44444444-4444-4444-4444-444444444444','0xempty','aaaaaaaa-0000-0000-0000-000000000001',
   9, 999.00, 'LEGENDARY', now() - interval '10 hours'),
  -- no user_id: cannot be attributed, so it is not refreshed (but IS zeroable)
  (NULL,'0xnouser','aaaaaaaa-0000-0000-0000-000000000001', NULL, NULL, NULL, now() - interval '10 hours');

INSERT INTO public.wallet_moments_cache VALUES
  ('0xnever','aaaaaaaa-0000-0000-0000-000000000001'),
  ('0xstale','aaaaaaaa-0000-0000-0000-000000000001'),
  ('0xfresh','aaaaaaaa-0000-0000-0000-000000000001'),
  ('0xnouser','aaaaaaaa-0000-0000-0000-000000000001');

CALL public.reconcile_all_saved_wallet_stats();

-- ── ⚠ THE ZERO PASS IS THE HONEST HALF, AND ITS ASYMMETRY IS THE POINT ──────
-- A wallet that no longer holds any moments gets count 0 — a real, knowable fact — but
-- FMV and top tier go to NULL, NOT to 0 and NOT to the last known values. A 0 dollar
-- figure would be a claim about worth; NULL is the absence of one. Carrying the old
-- $999 forward would be worse still: a portfolio value for moments the collector no
-- longer owns.
SELECT _assert_eq((SELECT cached_moment_count::text FROM public.saved_wallets WHERE wallet_addr='0xempty'),
  '0', 'a wallet with no moments is zeroed to 0 moments — that much IS known');
SELECT _assert((SELECT cached_fmv_usd FROM public.saved_wallets WHERE wallet_addr='0xempty') IS NULL,
  'but its FMV goes to NULL, not 0 — "no moments" is a count, not a valuation, and a hard '
  '$0.00 would be a claim the data does not support');
SELECT _assert((SELECT cached_top_tier FROM public.saved_wallets WHERE wallet_addr='0xempty') IS NULL,
  'and the stale top tier is cleared rather than carried forward');

-- The zero pass is keyed on holdings, NOT on user attribution: an unattributed wallet is
-- still zeroed if it holds nothing. Here 0xnouser DOES hold moments, so it is untouched.
SELECT _assert((SELECT cached_moment_count FROM public.saved_wallets WHERE wallet_addr='0xnouser') IS NULL,
  'a wallet that still holds moments is not zeroed, even with no user_id');

-- ── The staleness gate, in both directions ─────────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM public._refreshed WHERE wallet_addr='0xfresh'), '0',
  'a wallet refreshed 5 minutes ago is INSIDE the 360-minute gate and is skipped — without '
  'it the hourly sweep would re-walk every wallet every hour on a 2 GB IO-throttled instance');
SELECT _assert_eq((SELECT count(*)::text FROM public._refreshed WHERE wallet_addr IN ('0xnever','0xstale')),
  '2', 'both stale wallets are refreshed');
SELECT _assert_eq((SELECT count(*)::text FROM public._refreshed WHERE wallet_addr='0xnouser'), '0',
  'a wallet with no user_id is not refreshable — the per-wallet RPC is keyed on (user, wallet)');

-- ── Ordering: never-refreshed first, then stalest ──────────────────────────
-- NULLS FIRST is load-bearing. A wallet that has NEVER been refreshed is the one whose
-- card is showing nothing at all, and under a soft deadline the tail is what gets dropped.
SELECT _assert_eq((SELECT wallet_addr FROM public._refreshed ORDER BY seq LIMIT 1), '0xnever',
  'the never-refreshed wallet is served FIRST (ORDER BY stalest ASC NULLS FIRST) — under a '
  'deadline the sweep drops its tail, so ordering decides who goes another hour unserved');

-- ── ⚠ A TRUNCATED SWEEP REPORTS ok = FALSE, NOT A SMALLER SUCCESS ──────────
-- This is the property most worth protecting. A partial sweep that reported success would
-- be a silently-sliced result: every wallet it did reach is correct, so nothing downstream
-- looks wrong, and the wallets it never reached keep serving stale figures indefinitely.
--
-- The default-argument call above swept everything, so it is the ok = TRUE control. Pinning
-- that direction matters too: an arm that is permanently red is its own kind of useless
-- (the ufc_fmv_stale_hours cry-wolf cost this repo an operator who learned to skim a red board).
SELECT _assert_eq((SELECT ok::text FROM public._runs), 'true',
  'a sweep that reached every owed wallet reports ok = true');
SELECT _assert((SELECT (extra->>'oldest_cache_h')::numeric FROM public._runs) IS NOT NULL,
  'and carries the oldest cache age, the figure that shows whether the sweep is keeping up');

DELETE FROM public._runs; DELETE FROM public._refreshed;
UPDATE public.saved_wallets SET cache_updated_at = now() - interval '10 hours';
CALL public.reconcile_all_saved_wallet_stats(p_max_seconds => 50, p_max_wallets => 1,
                                             p_min_age_minutes => 360);
SELECT _assert_eq((SELECT count(*)::text FROM public._refreshed), '1',
  'p_max_wallets = 1 stops the sweep after one wallet');
SELECT _assert_eq((SELECT ok::text FROM public._runs), 'false',
  'and that run is ok = FALSE — a bounded sweep is a PARTIAL result, never a small success');
SELECT _assert_eq((SELECT extra->>'error' FROM public._runs),
  'soft_deadline_reached_partial_sweep_committed',
  'it NAMES the reason, including that the partial work was COMMITTED — so an operator '
  'reading the row knows both that it stopped early and that it did not roll back');
SELECT _assert_eq((SELECT extra->>'wallets_done' FROM public._runs), '1',
  'the payload states how many were done...');
SELECT _assert((SELECT (extra->>'wallets_total')::int FROM public._runs) > 1,
  '...against how many were owed, so the shortfall is readable rather than inferred');

-- ⚠ AND THE PARTIAL WORK REALLY IS DURABLE. The per-wallet COMMIT is why: the wallet the
-- truncated sweep did reach keeps its refreshed figures, so the next tick starts from
-- progress rather than repeating it. Rolling back on truncation would make a sweep that
-- cannot finish inside its budget never finish at all.
SELECT _assert_eq((SELECT count(*)::text FROM public.saved_wallets
                    WHERE wallet_addr = (SELECT wallet_addr FROM public._refreshed ORDER BY seq LIMIT 1)
                      AND cache_updated_at > now() - interval '1 minute'), '1',
  'the one wallet the truncated sweep reached kept its refresh — per-wallet COMMIT means '
  'progress survives the deadline');

SELECT '✓ reconcile_all_saved_wallet_stats invariants pass' AS result;

\c postgres
DROP DATABASE rpc_dbtest_reconcile;
