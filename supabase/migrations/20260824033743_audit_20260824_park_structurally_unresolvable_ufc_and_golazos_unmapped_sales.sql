-- ⭐ UFC and Golazos burn ~500 s/day in promote_unmapped_sales and have promoted
-- ZERO rows, ever. This parks them using the function's OWN existing mechanism —
-- no function change, no cron change, no new gate.
--
-- MEASURED 2026-08-24 ~03:40Z, 72-hour window from pipeline_runs:
--   leg             runs  eligible  promoted   total_s
--   nfl_all_day      804       625       545    22,817   <- the leg doing real work
--   ufc_strike       119         0         0     1,043
--   laliga_golazos   326         0         0       455
-- 445 runs across the two legs, **zero eligible and zero promoted**, ~499 s/day.
-- `unmapped_sales.resolved_at` has NEVER been set for either collection
-- (max(resolved_at) IS NULL for both) — this is not "slow", it is "never".
--
-- ⛔ WHY, exactly — all FOUR resolution branches are structurally empty:
--   UFC (1,070 unresolved)        Golazos (9 unresolved)
--     hint 'edition_id'         0            0
--     hint 'set_id_onchain'     0            0
--     in nft_edition_map        0            0
--     in wallet_moments_cache   0            0
-- Every row passes the price guard, so they ARE scanned in full every run and
-- then fail all four EXISTS branches. UFC has 533 nft_edition_map rows and 518
-- editions overall — the map simply has no overlap with these nft_ids. The rows
-- lack the identifiers the resolver needs; nothing here is retryable today.
--
-- ⛔ WHY NOT A GATE. The obvious `IF eligible = 0 THEN skip` is refuted and
-- recorded: eligibility IS the four-branch EXISTS scan, so the guard costs
-- exactly what it guards. A hardcoded per-collection skip list is worse — it
-- welds the door shut and rots silently the day UFC becomes resolvable.
--
-- ✅ WHAT THIS DOES INSTEAD. promote_unmapped_sales already implements precisely
-- this case. Its `candidates` CTE opens with
--     AND NOT (us.resolution_hint ? 'promote_recheck_after'
--              AND (us.resolution_hint->>'promote_recheck_after')::timestamptz > now())
-- and its own `mark_blocked` arm sets that key for rows it proves un-promotable.
-- A jsonb key test is far cheaper than four EXISTS with joins and is evaluated
-- first, so marked rows never reach the expensive branches. This migration marks
-- the existing structurally-unresolvable rows the same way.
--
-- ⭐ AND IT STAYS FALSIFIABLE. The horizon is 30 days (the function's own
-- convention), so the whole population is automatically re-tested monthly at the
-- cost of ONE normal run. If upstream ever populates hints or extends the map,
-- the rows resolve at that recheck. Nothing is deleted, nothing is hidden:
-- `still_unresolved` / `open_backlog` in the run telemetry keep counting them.
--
-- ⚠ The WHERE clause RE-VERIFIES every branch per row at mark time rather than
-- trusting the collection-level counts above, so a row that could resolve is
-- never parked. Expected: 1,079 rows (1,070 UFC + 9 Golazos).
-- ⚠ COALESCE on resolution_hint is load-bearing: `NULL ?| array[...]` is NULL and
-- `NOT NULL` is NULL, which would silently EXCLUDE the most unresolvable rows.
--
-- ⚠ New UFC rows keep arriving (481 in 30d, 15 in 7d) and will not carry the
-- marker, so per-run cost decays back slowly — ~16/day against 1,070 parked. The
-- durable version is for the function to mark no-path rows itself; filed, not
-- shipped here, because that is a change to a large and carefully-commented
-- function and this captures ~98% of the benefit with no code change.
--
-- REVERT:
--   UPDATE public.unmapped_sales
--      SET resolution_hint = resolution_hint - 'promote_blocked'
--                                            - 'promote_blocked_at'
--                                            - 'promote_recheck_after'
--    WHERE resolution_hint->>'promote_blocked' = 'no_resolution_path_all_four_branches_empty';
UPDATE public.unmapped_sales us
   SET resolution_hint = COALESCE(us.resolution_hint, '{}'::jsonb)
         || jsonb_build_object(
              'promote_blocked',       'no_resolution_path_all_four_branches_empty',
              'promote_blocked_at',    to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
              'promote_recheck_after', to_char(now() + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SSOF'))
 WHERE us.collection_id IN (
         '9b4824a8-736d-4a96-b450-8dcc0c46b023',  -- ufc_strike
         '06248cc4-b85f-47cd-af67-1855d14acd75'   -- laliga_golazos
       )
   AND us.resolved_at IS NULL
   AND NOT (COALESCE(us.resolution_hint, '{}'::jsonb) ? 'promote_recheck_after')
   AND NOT (COALESCE(us.resolution_hint, '{}'::jsonb) ?| array['edition_id', 'set_id_onchain'])
   AND NOT EXISTS (
         SELECT 1 FROM public.nft_edition_map nem
          WHERE nem.collection_id = us.collection_id AND nem.nft_id = us.nft_id)
   AND NOT EXISTS (
         SELECT 1 FROM public.wallet_moments_cache w
          WHERE w.moment_id = us.nft_id AND w.collection_id = us.collection_id);