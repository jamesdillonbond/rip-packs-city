-- backfill_null_serial_sales_from_moments: add nft_edition_map as a THIRD source.
--
-- Measured 2026-09-02 over every null-serial `sales` row carrying a real nft_id:
--   collection        all-time null   covered by moments/wmc   GAINED from nem   unresolvable
--   nfl_all_day        2,180            502                     1,678             0
--   nba_top_shot       1,096              0                         2         1,094
--   ufc_strike            10              0                        10             0
--   laliga_golazos         2              0                         2             0
-- => 2,192 sales gain a real serial, and AllDay's unresolvable remainder is ZERO.
--
-- Positive control (the rule: a POSITIVE result needs a control the fix cannot
-- move) — on sales that ALREADY carry a serial, nft_edition_map AGREES:
--   AllDay 5,775/5,775 (1-in-20 hash sample) - TopShot 143,496/143,497 -
--   UFC 1,351/1,351 - Golazos 463/463.  145,311 checked, 145,310 agree.
--
-- The new leg is placed THIRD so it can never overwrite `moments` or
-- `wallet_moments_cache`; existing precedence (a) is unchanged, and so is the
-- `> 0` guard (b), the age window / idempotence (c) and the return (d).
--
-- Cost, measured warm, unbounded (p_max_age_days => 3650) on the three-leg
-- candidate scan: 1.94 s / 33,602 buffers — inside the function's own 60 s
-- statement_timeout, so a one-shot drain pass is feasible.
-- nft_edition_map_pkey is UNIQUE (collection_id, nft_id), so the leg is an
-- index scan of exactly one row.

-- anon-exec: unchanged-by-replace (backfill_null_serial_sales_from_moments) — this is a
-- CREATE OR REPLACE of a function that has existed since 20260705, and CREATE OR REPLACE
-- FUNCTION does not reset an ACL, so a REVOKE here would CHANGE production rather than
-- describe it. Verified live before writing this line: has_function_privilege reads
-- anon=false, authenticated=false, service_role=true. The only callers are pg_cron
-- jobid 76 and the sales-serial-backfill lane; nothing reaches it from a browser.
CREATE OR REPLACE FUNCTION public.backfill_null_serial_sales_from_moments(p_max_age_days integer DEFAULT 45)
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

-- ── POST-STATE: assert the shape we intended, not merely that the DDL parsed ──
DO $mig$
DECLARE
  d text := pg_get_functiondef('public.backfill_null_serial_sales_from_moments(integer)'::regprocedure);
  p_m int; p_w int; p_n int;
BEGIN
  IF position('nft_edition_map' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: the nft_edition_map leg is absent from the deployed definition';
  END IF;

  p_m := position('FROM moments m' in d);
  p_w := position('FROM wallet_moments_cache w' in d);
  p_n := position('FROM nft_edition_map nem' in d);
  IF p_m = 0 OR p_w = 0 OR p_n = 0 THEN
    RAISE EXCEPTION 'post-state: a COALESCE leg is missing (moments=%, wmc=%, nem=%)', p_m, p_w, p_n;
  END IF;
  -- PRECEDENCE is the invariant this change must not move: nem strictly LAST.
  IF NOT (p_m < p_w AND p_w < p_n) THEN
    RAISE EXCEPTION 'post-state: leg order is wrong (moments=%, wmc=%, nem=%) — nem must be third', p_m, p_w, p_n;
  END IF;

  -- The `> 0` guard must apply to the new leg too, or a fake serial #0 lands.
  IF position('AND nem.serial_number > 0' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: the new leg is missing its serial_number > 0 guard';
  END IF;

  -- Hardening that predates this change and must survive it.
  IF position('SECURITY DEFINER' in d) = 0
     OR position('search_path' in d) = 0
     OR position('statement_timeout' in d) = 0 THEN
    RAISE EXCEPTION 'post-state: SECURITY DEFINER / search_path / statement_timeout were dropped';
  END IF;
END
$mig$;
