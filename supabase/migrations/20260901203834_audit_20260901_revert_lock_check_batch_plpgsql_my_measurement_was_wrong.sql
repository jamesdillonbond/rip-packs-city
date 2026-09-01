-- audit_20260901_revert_lock_check_batch_plpgsql_my_measurement_was_wrong
-- anon-exec: get_lock_check_batch — SECURITY DEFINER, service_role-only; ACL unchanged (identical
-- signature, CREATE OR REPLACE preserves it). anon EXECUTE remains false.
--
-- ⛔ REVERT of audit_20260901_lock_check_batch_plpgsql_force_custom_plan_so_the_slug_filter_pushes_down,
-- shipped minutes earlier in this same pass. THE JUSTIFICATION IN THAT MIGRATION'S HEADER IS WRONG AND
-- I AM WITHDRAWING IT. Restoring the original `LANGUAGE sql` definition byte-for-byte.
--
-- WHAT I CLAIMED: that `LANGUAGE sql` param-blind planning forced the CROSS JOIN LATERAL to run for all
-- seven collections, and that a custom plan would cut 15,711 buffers to ~3,204 — "4.9x from plan shape
-- alone."
--
-- WHAT ACTUALLY HAPPENED — the change measured NOTHING:
--     function, LANGUAGE sql (generic plan) ..... 15,711 buffers
--     function, plpgsql + force_custom_plan ..... 15,736 buffers
-- Identical within noise. Wall-clock looked 2.6x better (8,808 -> 3,446 ms) and that was warm cache,
-- which is exactly the trap this repo has written down twice.
--
-- ⛔⛔ WHERE THE 3,204 CAME FROM — A NEW MEASUREMENT TRAP, AND IT IS SUBTLE:
-- my "same body with a literal" control was `SELECT count(*) FROM cand` — only the first CTE, wrapped
-- in an aggregate. Because `count(*)` needs no column values, the planner switched the hot-wallet probe
-- from an **Index Scan** to an **Index ONLY Scan** on idx_wmc_lock_wallet_coll:
--     count(*) control ....... Index Only Scan, Heap Fetches: 525,  buffers 2,945
--     real query ............. Index Scan,      heap fetch per row, buffers 13,523
-- The index is (wallet_address, collection_id, lock_checked_at) and does NOT contain moment_id or
-- edition_key, so the real query must visit the heap for every one of the ~11,978 candidate rows.
-- **My control silently deleted the dominant cost and I attributed the difference to the plan shape.**
-- Re-run properly, the FULL body with a literal slug is 13,805 buffers — 12% below the function, not
-- 4.9x. There was never a 4.9x to win.
--
-- 👉 THE RULE: an aggregate wrapper can change the SCAN TYPE. When measuring a query, the control must
-- project the SAME COLUMNS as the real query — `count(*)` is not a neutral wrapper over a candidate set.
--
-- WHY REVERT RATHER THAN KEEP A HARMLESS CHANGE: it is not free. plpgsql's RETURN QUERY is STRICT about
-- result types where `LANGUAGE sql` is not, which forced a `::text` cast on `collections.slug`
-- (varchar(50) -> text) that the original never needed. That is a real behavioural surface added for a
-- benefit that does not exist. This repo's own precedent is explicit — the 2026-08-31
-- fmv_backfill_candidates rewrite that "looked 2x faster" was deliberately NOT shipped once re-measured
-- in the same cache state. Same call here.
--
-- ✅ WHAT IS STILL TRUE, AND IS THE REAL TARGET: get_lock_check_batch is the #5 consumer at ~21,261
-- blocks/call, ~97 calls/day (~17 GB/day), and **13,523 of its ~15,700 buffers are the priority leg**:
-- 584 hot wallets x one lateral probe each, every probe heap-fetching ~21 rows to read moment_id and
-- edition_key. The fix is therefore an INDEX, not a plan hint — extend idx_wmc_lock_wallet_coll with
-- `INCLUDE (moment_id, edition_key)` so those probes become index-only. Estimated 15,700 -> ~3,000
-- (~10 GB/day), at a cost of roughly +40-60 MB on a 67 MB index over an UPDATE-heavy table.
-- ⛔ NOT shipped in this pass: it is a large index build on wallet_moments_cache and belongs in the
-- quiet band (02:00-04:00Z), per the REINDEX-is-concurrency-not-size finding. Build it CONCURRENTLY via
-- the one-off pg_cron recipe, then RE-MEASURE the function on BUFFERS before believing it.
--
-- REVERT OF THIS REVERT: re-apply the plpgsql version — but do not, unless the INCLUDE index is in and
-- a custom plan is then shown to matter on buffers.

CREATE OR REPLACE FUNCTION public.get_lock_check_batch(p_collection_slug text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_max_age_days integer DEFAULT 7)
 RETURNS TABLE(out_wallet_address text, out_moment_id text, out_collection_id uuid, out_collection_slug text, out_edition_key text, out_is_priority boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
  WITH hot AS (
    SELECT seeded_wallets.wallet_address AS addr FROM seeded_wallets
    UNION
    SELECT saved_wallets.wallet_addr FROM saved_wallets
    UNION
    SELECT linked_accounts.parent_addr FROM linked_accounts
    UNION
    SELECT linked_accounts.child_addr FROM linked_accounts
  ),
  cand AS (
    SELECT c.id AS cid, c.slug AS cslug,
           x.wallet_address, x.moment_id, x.edition_key, x.lock_checked_at, x.forced_priority
    FROM collections c
    CROSS JOIN LATERAL (
      ( SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at, false AS forced_priority
        FROM wallet_moments_cache w
        WHERE w.collection_id = c.id
          AND (w.lock_checked_at IS NULL
               OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
        ORDER BY w.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
      UNION ALL
      ( SELECT w2.wallet_address, w2.moment_id, w2.edition_key, w2.lock_checked_at, true AS forced_priority
        FROM hot h
        CROSS JOIN LATERAL (
          SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at
          FROM wallet_moments_cache w
          WHERE w.wallet_address = h.addr
            AND w.collection_id = c.id
            AND (w.lock_checked_at IS NULL
                 OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
          ORDER BY w.lock_checked_at ASC NULLS FIRST
          LIMIT p_limit
        ) w2
        ORDER BY w2.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
    ) x
    WHERE (p_collection_slug IS NULL OR c.slug = p_collection_slug)
  ),
  dedup AS (
    SELECT cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key,
           bool_or(cand.forced_priority) AS is_priority,
           min(cand.lock_checked_at) AS lock_checked_at
    FROM cand
    GROUP BY cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key
  ),
  ranked AS (
    SELECT dedup.wallet_address, dedup.moment_id, dedup.cid, dedup.cslug, dedup.edition_key, dedup.is_priority,
      ROW_NUMBER() OVER (
        PARTITION BY dedup.cid
        ORDER BY dedup.is_priority DESC, dedup.lock_checked_at ASC NULLS FIRST
      ) AS rn
    FROM dedup
  )
  SELECT ranked.wallet_address, ranked.moment_id, ranked.cid, ranked.cslug, ranked.edition_key, ranked.is_priority
  FROM ranked
  ORDER BY ranked.rn, ranked.cid
  LIMIT p_limit;
$function$;

COMMENT ON FUNCTION public.get_lock_check_batch(text, integer, integer) IS
  'Lock-check queue picker. MEASURED 2026-09-01 — the #5 consumer on this instance at ~21,261 '
  'shared_blks_read and ~16.5 s per call, ~97 calls/day (~17 GB/day of disk reads). '
  'THE COST IS THE PRIORITY LEG, AND IT IS HEAP FETCHES, NOT PLAN SHAPE. The `hot` CTE '
  '(seeded_wallets UNION saved_wallets UNION both linked_accounts sides) resolves to 584 wallets, and '
  'the second branch of the CROSS JOIN LATERAL runs one probe per hot wallet: 584 Index Scans on '
  'idx_wmc_lock_wallet_coll returning ~21 rows each (~11,978 rows), and because that index is '
  '(wallet_address, collection_id, lock_checked_at) with NO payload, every row costs a HEAP FETCH to '
  'read moment_id and edition_key. That is 13,523 of the ~15,700 buffers. '
  '👉 THE FIX IS AN INDEX: extend idx_wmc_lock_wallet_coll with INCLUDE (moment_id, edition_key) so the '
  'probes become Index Only Scans. Estimated ~15,700 -> ~3,000 buffers (~10 GB/day) for roughly '
  '+40-60 MB. Build it CONCURRENTLY in the quiet band (02:00-04:00Z) via the one-off pg_cron recipe, '
  'then RE-MEASURE on buffers. '
  '⛔ ALREADY TRIED AND REVERTED 2026-09-01: converting this to plpgsql with '
  'plan_cache_mode=force_custom_plan, on the theory that LANGUAGE sql param-blindness made the lateral '
  'run for all seven collections. It measured 15,711 -> 15,736 buffers, i.e. nothing. Do not re-derive '
  'it. The "4.9x" that motivated it was a measurement error: the control used SELECT count(*), which '
  'let the planner use an Index ONLY Scan and silently deleted the heap fetches that are the real cost. '
  '⛔ DO NOT lower the inner LIMIT p_limit — in the worst case one hot wallet legitimately supplies all '
  'output rows, so it is load-bearing for correctness. '
  '⚠ This is LANGUAGE sql, so it is planned param-blind: EXPLAIN the FUNCTION, never the body with '
  'literals — and make any control project the SAME COLUMNS as the real query.';

DO $mig$
DECLARE
  v_lang name;
  v_cfg  text[];
  v_rows int;
BEGIN
  SELECT l.lanname, p.proconfig INTO v_lang, v_cfg
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'get_lock_check_batch';

  IF v_lang <> 'sql' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected the original LANGUAGE sql, got %', v_lang;
  END IF;
  IF 'plan_cache_mode=force_custom_plan' = ANY(v_cfg) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: plan_cache_mode is still set — the revert did not take';
  END IF;
  IF NOT ('statement_timeout=120s' = ANY(v_cfg)) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the 120s statement_timeout was lost';
  END IF;
  IF has_function_privilege('anon', 'public.get_lock_check_batch(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_lock_check_batch(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE — the caller would 403';
  END IF;

  -- Behavioural: the restored function must still serve the real caller's argument shape.
  SELECT count(*) INTO v_rows FROM public.get_lock_check_batch('nba_top_shot', 50, 7);
  IF v_rows <> 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 50 rows, got %', v_rows;
  END IF;
END
$mig$;