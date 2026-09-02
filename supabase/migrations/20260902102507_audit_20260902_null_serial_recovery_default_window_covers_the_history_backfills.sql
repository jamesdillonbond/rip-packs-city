-- backfill_null_serial_sales_from_moments: widen the DEFAULT age window 45d -> 3650d.
--
-- THE LEAK. The hourly job (pg_cron jobid 76, `5 * * * *`, cron_heavy-owned) calls
-- this with no argument, so the 45-day default governs. The `*-sales-history-backfill`
-- walkers write HISTORICAL sales — by construction `sold_at` far older than 45 days —
-- so every null-serial row they produce is permanently outside the window the recovery
-- job can see. Measured 2026-09-02 ~10:2xZ, 80 minutes after an unbounded drain pass
-- had taken AllDay to zero:
--
--   AllDay null-serial sales with a real nft_id      499
--   ...of them within the 45-day window                0
--   ...that RESOLVE from the three legs today        499   <- 100%
--   ...ingested in the last 2 hours                  499   (sold_at 2025-12-29..2026-01-22)
--
-- The 09:52Z `allday-studio-sales-history-backfill` tick alone contributed ~378 of them.
-- They are 100% recoverable and the job could never reach any of them.
--
-- COST, measured like-for-like in one session with the leg probes forced (a bare
-- count(*) lets the planner drop the COALESCE subplans and reads ~15x cheaper — do
-- not compare against that shape):
--
--   window     rows scanned   buffers   time
--   45 days       1,094       10,593    826 ms
--   3,650 days    1,593       15,895    2,634 ms
--
-- +5,302 buffers and +1.8 s per hourly run, against a 60 s statement_timeout. Every
-- partition carries an `idx_sales_<year>_serial_backfill_targets` index, so the wider
-- window is index scans on the empty years rather than seq scans (verified in the plan).
--
-- ⚠ The 45-day figure is NOT a saving: all 1,094 rows it scans are Top Shot rows that
-- resolve from none of the three legs — they belong to the separately-dead
-- `sales-serial-backfill` edge lane. The current job spends 10,593 buffers an hour
-- re-probing rows that cannot resolve locally, and skips the 499 that can.
--
-- ⛔ WHY THE DEFAULT AND NOT THE CRON COMMAND: jobid 76 is owned by `cron_heavy`, and
-- no session-reachable role may EXECUTE cron.alter_job on a job it owns (`postgres` is
-- a member but not the owner; has_table_privilege on cron.job UPDATE is false). The
-- command is therefore operator-only. The default is not.
--
-- The parameter survives, so any caller can still bound the window explicitly, and the
-- pinned test now drives BOTH the explicit 45 and the wide default.
--
-- anon-exec: unchanged-by-replace (backfill_null_serial_sales_from_moments) — a CREATE
-- OR REPLACE of a function that has existed since 20260705, and CREATE OR REPLACE
-- FUNCTION does not reset an ACL, so a REVOKE here would CHANGE production rather than
-- describe it. Verified live: has_function_privilege reads anon=false,
-- authenticated=false, service_role=true.

CREATE OR REPLACE FUNCTION public.backfill_null_serial_sales_from_moments(p_max_age_days integer DEFAULT 3650)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH cand AS (
    SELECT
      s.id AS sale_id,
      COALESCE(
        (SELECT m.serial_number
           FROM moments m
          WHERE m.nft_id = s.nft_id
            AND m.serial_number > 0
          LIMIT 1),
        (SELECT w.serial_number
           FROM wallet_moments_cache w
          WHERE w.collection_id = s.collection_id
            AND w.moment_id = s.nft_id
            AND w.serial_number > 0
          LIMIT 1),
        (SELECT nem.serial_number
           FROM nft_edition_map nem
          WHERE nem.collection_id = s.collection_id
            AND nem.nft_id = s.nft_id
            AND nem.serial_number > 0
          LIMIT 1)
      ) AS serial_number
    FROM sales s
    WHERE s.serial_number IS NULL
      AND s.nft_id IS NOT NULL
      AND s.nft_id <> ''
      AND s.sold_at > now() - make_interval(days => p_max_age_days)
  )
  UPDATE sales s
     SET serial_number = c.serial_number
    FROM cand c
   WHERE s.id = c.sale_id
     AND c.serial_number IS NOT NULL
     AND s.serial_number IS NULL;   -- idempotent: never clobber a resolved serial

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

-- ── POST-STATE ───────────────────────────────────────────────────────────────
DO $mig$
DECLARE
  d text := pg_get_functiondef('public.backfill_null_serial_sales_from_moments(integer)'::regprocedure);
  v_default text;
  v_out_of_window int;
BEGIN
  -- The DEFAULT is the whole change; assert it from the catalogue, not the text.
  SELECT pg_get_expr(p.proargdefaults, 0) INTO v_default
  FROM pg_proc p WHERE p.oid = 'public.backfill_null_serial_sales_from_moments(integer)'::regprocedure;
  IF v_default IS NULL OR position('3650' in v_default) = 0 THEN
    RAISE EXCEPTION 'post-state: the default window is % , expected 3650', coalesce(v_default, '<none>');
  END IF;

  -- Everything the previous migration pinned must survive a replace.
  IF position('FROM moments m' in d) = 0
     OR position('FROM wallet_moments_cache w' in d) = 0
     OR position('FROM nft_edition_map nem' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: a COALESCE leg went missing';
  END IF;
  IF NOT (position('FROM moments m' in d) < position('FROM wallet_moments_cache w' in d)
          AND position('FROM wallet_moments_cache w' in d) < position('FROM nft_edition_map nem' in d)) THEN
    RAISE EXCEPTION 'post-state: leg precedence changed';
  END IF;
  IF position('AND nem.serial_number > 0' in d) = 0
     OR position('SECURITY DEFINER' in d) = 0
     OR position('statement_timeout' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: a guard or a hardening clause was dropped';
  END IF;

  -- Non-vacuous: there must actually BE work outside the old window, or this change
  -- is a cost with no benefit and someone should know before it ships.
  SELECT count(*) INTO v_out_of_window
  FROM sales s
  WHERE s.serial_number IS NULL AND s.nft_id IS NOT NULL AND s.nft_id <> ''
    AND s.sold_at <= now() - make_interval(days => 45);
  RAISE NOTICE 'null-serial sales outside the old 45-day window: %', v_out_of_window;
END
$mig$;
