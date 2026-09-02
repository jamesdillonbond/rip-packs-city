-- ⚠⚠ TWO SESSIONS SHIPPED THIS SAME FIX 3.5 MINUTES APART, AND PICKED THE SAME MIGRATION NAME.
-- Read this before concluding the repo has a duplicate.
--
--   20260902034649  Cowork session 014wx7Jm  applied 03:46:49Z  (commit 2006b31e5)
--   20260902035016  THIS FILE,   session 01CNcuqq  applied 03:50:16Z  ← the LIVE body
--
-- Both drained the same inbox filing (2026-09-02T0330Z), independently re-derived the same numbers,
-- and independently found the same load-bearing detail (the tier must also go on the priority leg's
-- OWN `ORDER BY ... LIMIT p_limit`, or user rows are discarded before `dedup`/`ranked` see them).
-- Neither file is wrong and BOTH rows are real, so both are kept: `check-migration-parity.mjs` keys
-- on NAME, so one committed file would have satisfied it and hidden the second applied row.
--
-- THE TWO BODIES ARE OUTPUT-EQUIVALENT. The only differences:
--   1. This one adds `WHERE u.addr IS NOT NULL` to `hot`. One `linked_accounts` side is nullable and
--      contributes exactly 1 NULL address; `w.wallet_address = NULL` is never true, so that group
--      could only ever cost a probe and never produce a row. Output-identical by construction.
--   2. `ranked` orders `is_priority DESC, is_user_wallet DESC` here and `is_user DESC, is_priority
--      DESC` there. Equivalent: the non-priority leg hardcodes `false AS is_user` in BOTH bodies, so
--      is_user ⇒ is_priority and neither key can overtake the other.
--
-- ⭐ THE TRANSFERABLE PART: the collision was invisible until `git push` returned
-- `(non-fast-forward)`. Two sessions draining the same inbox took the same top item within minutes,
-- and nothing in the inbox, the ledger or the DB marked it as claimed. If you are draining that
-- queue, `git fetch origin main` FIRST and re-read the top of the ledger — a filing that says
-- "first thing to ship next pass" is exactly the one another session is also reading.
--
-- audit_20260902_lock_check_batch_prioritises_user_wallets_over_seeded_coverage
-- anon-exec: get_lock_check_batch — SECURITY DEFINER, service_role-only. IDENTICAL signature and
-- RETURNS TABLE, so CREATE OR REPLACE preserves the ACL; anon EXECUTE remains false (asserted below).
--
-- WHAT THIS FIXES (filed 2026-09-02T0330Z, re-derived independently before shipping)
-- `lock-check-batch` has been 48/48 ok, full-rate, and delivering 100% of its output to SEEDED
-- COVERAGE wallets and 0% to the wallets users actually saved or linked. Re-measured on this
-- instance immediately before this migration, Top Shot, trailing 24 h:
--
--     class          checks_24h   distinct wallets
--     seeded_only         9,590                 12
--     user                    0                  0
--
-- and on the other side: 31 user wallets hold 212,201 Top Shot rows, of which 212,201 (100%)
-- qualify for a lock check. The priority leg exists specifically to favour wallets users care
-- about; it was delivering none of its output to them.
--
-- WHY. `hot` UNIONs seeded_wallets, saved_wallets and both linked_accounts sides with NO preference
-- among them, so a seeded wallet is indistinguishable from a user wallet in the ordering. 1,474,231
-- of 1,904,215 Top Shot rows have `lock_checked_at IS NULL`, so `ORDER BY lock_checked_at ASC NULLS
-- FIRST` is one enormous tie — and when everything ties, the tie-break decides everything. The
-- tie-break is effectively scan order, and 218 seeded wallets with 1.49M rows outweigh 31 user
-- wallets with 212k. Mass wins, every run, forever.
--
-- THE CHANGE: a wallet CLASS tier ahead of the timestamp, in BOTH places the tie is broken.
--   1. `hot` now carries `is_user_wallet` (saved/linked = true, seeded-only = false), folded with
--      bool_or so a wallet that is both counts as a user wallet.
--   2. the priority leg's own `ORDER BY … LIMIT p_limit` — this one is load-bearing and is the
--      reason a tier in `ranked` alone would have done NOTHING: that inner LIMIT collapses ~11,978
--      probed rows to p_limit BEFORE `dedup`/`ranked` ever see them, so if user rows lose there they
--      are already gone.
--   3. `dedup` folds the flag (bool_or) and `ranked` orders `is_priority DESC, is_user_wallet DESC,
--      lock_checked_at ASC NULLS FIRST`.
--
-- ⛔ WHAT THIS DELIBERATELY IS NOT: a per-wallet cap. Lowering the inner `LIMIT p_limit` was
-- considered and rejected — one hot wallet can legitimately own all p_limit rows of the correct
-- answer, so that limit is load-bearing for correctness (the prior migration's COMMENT says so and
-- it still stands). This is a strict PRIORITY change, not a fairness trade: nothing that was being
-- served is starved, because seeded coverage simply resumes once user wallets are current.
--
-- COST: unchanged. Same probes, same index, same row counts; the only additions are a boolean
-- carried through and one extra sort key over the ≤p_limit rows already being sorted. The
-- `WHERE u.addr IS NOT NULL` in `hot` removes one probe that could never match (`w.wallet_address =
-- NULL` is never true) — one linked_accounts side is nullable and contributed exactly 1 such addr.
-- Output is unchanged by that clause by construction.
--
-- EXPECTED: Top Shot's 200 rows/run go to user wallets until their 212,201-row backlog clears
-- (~22 days at today's unchanged 9,590 checks/day), then capacity returns to seeded coverage.
-- ⚠ VERIFY ON ROWS WRITTEN PER WALLET CLASS, NOT ON `ok` — this pipeline has been green and wrong
-- for its entire life, and a throughput arm cannot see a distribution failure.
-- FALSIFIER: if 24 h from now `wallet_moments_cache.lock_checked_at > now() - 24h` still shows 0
-- rows for saved/linked wallets on nba_top_shot, this did not take.
-- ⚠ It does NOT fix the arithmetic: 9,590 checks/day against a 7-day target needing ~271,000/day
-- stands. This makes scarce capacity go to the right wallets; it does not create capacity.
--
-- REVERT: re-apply 20260901203834_audit_20260901_revert_lock_check_batch_plpgsql_my_measurement_was_wrong
-- verbatim (that file holds the exact prior body).

CREATE OR REPLACE FUNCTION public.get_lock_check_batch(p_collection_slug text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_max_age_days integer DEFAULT 7)
 RETURNS TABLE(out_wallet_address text, out_moment_id text, out_collection_id uuid, out_collection_slug text, out_edition_key text, out_is_priority boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
  WITH hot AS (
    SELECT u.addr, bool_or(u.is_user_wallet) AS is_user_wallet
    FROM (
      SELECT seeded_wallets.wallet_address AS addr, false AS is_user_wallet FROM seeded_wallets
      UNION ALL
      SELECT saved_wallets.wallet_addr, true FROM saved_wallets
      UNION ALL
      SELECT linked_accounts.parent_addr, true FROM linked_accounts
      UNION ALL
      SELECT linked_accounts.child_addr, true FROM linked_accounts
    ) u
    WHERE u.addr IS NOT NULL
    GROUP BY u.addr
  ),
  cand AS (
    SELECT c.id AS cid, c.slug AS cslug,
           x.wallet_address, x.moment_id, x.edition_key, x.lock_checked_at, x.forced_priority,
           x.is_user_wallet
    FROM collections c
    CROSS JOIN LATERAL (
      ( SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at,
               false AS forced_priority, false AS is_user_wallet
        FROM wallet_moments_cache w
        WHERE w.collection_id = c.id
          AND (w.lock_checked_at IS NULL
               OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
        ORDER BY w.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
      UNION ALL
      ( SELECT w2.wallet_address, w2.moment_id, w2.edition_key, w2.lock_checked_at,
               true AS forced_priority, w2.is_user_wallet
        FROM hot h
        CROSS JOIN LATERAL (
          SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at,
                 h.is_user_wallet
          FROM wallet_moments_cache w
          WHERE w.wallet_address = h.addr
            AND w.collection_id = c.id
            AND (w.lock_checked_at IS NULL
                 OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
          ORDER BY w.lock_checked_at ASC NULLS FIRST
          LIMIT p_limit
        ) w2
        ORDER BY w2.is_user_wallet DESC, w2.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
    ) x
    WHERE (p_collection_slug IS NULL OR c.slug = p_collection_slug)
  ),
  dedup AS (
    SELECT cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key,
           bool_or(cand.forced_priority) AS is_priority,
           bool_or(cand.is_user_wallet) AS is_user_wallet,
           min(cand.lock_checked_at) AS lock_checked_at
    FROM cand
    GROUP BY cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key
  ),
  ranked AS (
    SELECT dedup.wallet_address, dedup.moment_id, dedup.cid, dedup.cslug, dedup.edition_key, dedup.is_priority,
      ROW_NUMBER() OVER (
        PARTITION BY dedup.cid
        ORDER BY dedup.is_priority DESC, dedup.is_user_wallet DESC, dedup.lock_checked_at ASC NULLS FIRST
      ) AS rn
    FROM dedup
  )
  SELECT ranked.wallet_address, ranked.moment_id, ranked.cid, ranked.cslug, ranked.edition_key, ranked.is_priority
  FROM ranked
  ORDER BY ranked.rn, ranked.cid
  LIMIT p_limit;
$function$;

COMMENT ON FUNCTION public.get_lock_check_batch(text, integer, integer) IS
  'Lock-check queue picker. '
  'ORDERING CONTRACT (2026-09-02): hot-wallet rows first, then USER wallets (saved_wallets / '
  'linked_accounts) ahead of SEEDED coverage wallets, then oldest lock_checked_at. The class tier is '
  'applied in TWO places and BOTH are load-bearing: the priority leg''s own ORDER BY ... LIMIT '
  'p_limit (which collapses ~11,978 probed rows before dedup/ranked can see them) and the final '
  'ROW_NUMBER. A tier in ranked alone changes NOTHING. '
  'WHY: 1,474,231 of 1,904,215 Top Shot rows have lock_checked_at IS NULL, so the timestamp order is '
  'one huge tie and the tie-break decides everything; 218 seeded wallets with 1.49M rows outweighed '
  '31 user wallets with 212k, and the pipeline delivered 9,590 checks/24h to 12 seeded wallets and '
  'ZERO to user wallets while reporting 48/48 ok. A throughput arm cannot see a distribution failure '
  '— verify this function on rows written PER WALLET CLASS, never on ok. '
  '⛔ DO NOT lower the inner LIMIT p_limit to spread work — in the worst case one hot wallet '
  'legitimately supplies all output rows, so it is load-bearing for correctness. The class tier is a '
  'strict priority, not a per-wallet cap. '
  'MEASURED 2026-09-01 — the #5 consumer on this instance at ~21,261 shared_blks_read and ~16.5 s per '
  'call, ~97 calls/day (~17 GB/day of disk reads). THE COST IS THE PRIORITY LEG, AND IT IS HEAP '
  'FETCHES, NOT PLAN SHAPE: 584 hot wallets x one lateral probe each on idx_wmc_lock_wallet_coll '
  '(wallet_address, collection_id, lock_checked_at), which has NO payload, so every one of ~11,978 '
  'rows costs a heap fetch to read moment_id and edition_key — 13,523 of the ~15,700 buffers. '
  '👉 THE FIX IS AN INDEX: extend idx_wmc_lock_wallet_coll with INCLUDE (moment_id, edition_key). '
  '⚠ 2026-09-02: idx_wmc_lock_wallet_coll_cover was built and KEPT (it halved the cost), but read '
  'the Heap Fetches: line before believing any Index Only Scan here — this pipeline''s own scattered '
  'UPDATEs un-mark the visibility map pages the next batch wants. '
  '⛔ ALREADY TRIED AND REVERTED 2026-09-01: plpgsql + plan_cache_mode=force_custom_plan measured '
  '15,711 -> 15,736 buffers, i.e. nothing. The "4.9x" that motivated it was a measurement error — '
  'the control used SELECT count(*), which let the planner use an Index ONLY Scan and silently '
  'deleted the heap fetches that are the real cost. '
  '⚠ This is LANGUAGE sql, so it is planned param-blind: EXPLAIN the FUNCTION, never the body with '
  'literals — and make any control project the SAME COLUMNS as the real query.';

DO $mig$
DECLARE
  v_lang name;
  v_cfg  text[];
  v_rows int;
  v_user_backlog bigint;
  v_seeded_in_batch int;
  v_user_in_batch int;
BEGIN
  SELECT l.lanname, p.proconfig INTO v_lang, v_cfg
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'get_lock_check_batch';

  IF v_lang <> 'sql' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected LANGUAGE sql, got %', v_lang;
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

  -- NO-CHANGE CONTROL: the batch must still be FULL. A tier that starved the picker would show up
  -- here as fewer than p_limit rows, which is the failure mode a priority change could plausibly
  -- introduce and which `ok=true` would never reveal.
  SELECT count(*) INTO v_rows FROM public.get_lock_check_batch('nba_top_shot', 50, 7);
  IF v_rows <> 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 50 rows, got %', v_rows;
  END IF;

  -- THE PROPERTY THIS MIGRATION EXISTS FOR, asserted as an ABSENCE, and guarded so it is not
  -- vacuous: only demand it while user wallets actually have qualifying work.
  WITH usr AS (
    SELECT DISTINCT addr FROM (
      SELECT saved_wallets.wallet_addr AS addr FROM saved_wallets
      UNION SELECT linked_accounts.parent_addr FROM linked_accounts
      UNION SELECT linked_accounts.child_addr FROM linked_accounts
    ) u WHERE u.addr IS NOT NULL
  )
  SELECT count(*) INTO v_user_backlog
  FROM wallet_moments_cache w
  JOIN collections c ON c.id = w.collection_id AND c.slug = 'nba_top_shot'
  JOIN usr ON usr.addr = w.wallet_address
  WHERE w.lock_checked_at IS NULL OR w.lock_checked_at < NOW() - interval '7 days';

  IF v_user_backlog > 0 THEN
    WITH usr AS (
      SELECT DISTINCT addr FROM (
        SELECT saved_wallets.wallet_addr AS addr FROM saved_wallets
        UNION SELECT linked_accounts.parent_addr FROM linked_accounts
        UNION SELECT linked_accounts.child_addr FROM linked_accounts
      ) u WHERE u.addr IS NOT NULL
    ), b AS (
      SELECT * FROM public.get_lock_check_batch('nba_top_shot', 200, 7)
    )
    SELECT count(*) FILTER (WHERE usr.addr IS NULL), count(*) FILTER (WHERE usr.addr IS NOT NULL)
      INTO v_seeded_in_batch, v_user_in_batch
    FROM b LEFT JOIN usr ON usr.addr = b.out_wallet_address;

    IF v_seeded_in_batch > 0 THEN
      RAISE EXCEPTION
        'POST-STATE FAILED: % of 200 batch rows went to seeded-only wallets while % user rows still qualify — the class tier did not take',
        v_seeded_in_batch, v_user_backlog;
    END IF;
    RAISE NOTICE 'post-state ok: 200/200 batch rows to user wallets (% user rows still qualifying)', v_user_backlog;
  ELSE
    RAISE NOTICE 'post-state: user backlog is empty, class-tier assertion skipped (not vacuous — it is satisfied)';
  END IF;
END
$mig$;
