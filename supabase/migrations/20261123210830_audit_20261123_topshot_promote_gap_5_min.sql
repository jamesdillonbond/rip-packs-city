-- audit_20261123_topshot_promote_gap_5_min
--
-- 2026-11-23 (Claude Code cloud; Trevor: "Keep going and work through anything you possibly can, leaving nothing
-- unresolved from this thread"). Closes the Top Shot sale-ingest lag thread (ledger 11-23 ~11 AM / 11:15 AM PT).
--
-- WHY. Parked (unmapped) Top Shot sales reach `sales` only through job 474 promote_unmapped_sales. 20261123185838 moved
-- jobs 476/474 hourly → every 10 min, but promote's built-in 20-minute minimum gap (c_min_gap, 20260830150207) made every
-- other run a skip. Measured 11-23 11:20 AM → 1:03 PM PT: Top Shot on-chain sale-ingest p50 3.8 min, p90 24.8 min
-- (n 129; was ~47 hourly). The decision recorded in focus.md: "> 20 min → a Top Shot-scoped 5-min gap".
-- c_min_gap was sized for All Day's 104,908-row unresolved scan; a Top Shot drain is 1-2 s over a 5-18 row backlog.
--
-- WHAT.
--   (1) promote_unmapped_sales: the gap is per scope — v_min_gap = 5 min for the Top Shot scope, c_min_gap (20) for every
--       other scope. Three edits to the body (declaration, the gap test, the logged min_gap_seconds); everything else is
--       byte-identical to 20261004030511 (live prosrc md5 be9ba6155972afdb7018f940db498d1c, verified immediately before).
--   (2) job 476 (resolve) → 1-59/5, job 474 (promote) → 3-59/5, so a resolved row is promoted 2 min later every 5 min.
--       Off :X0/:X5 (launcher blackout) and off the old :X7/:X9 slots, the two busiest minutes of the ten (31/34 active jobs by schedule
--       match; 1/6 = 17/22, 3/8 = 21/22). Lane budget: no job added.
-- Pin: supabase/tests/promote_unmapped_sales.sql (+3 assertions: TS runs at 6 min, skips at 3 min; All Day still skips
-- at 6 min — the control).
--
-- anon-exec: unchanged (revoked; service_role only) — CREATE OR REPLACE preserves the ACL (promote_unmapped_sales)
--
-- REVERT: re-apply the promote_unmapped_sales block of 20261004030511; then
--   SELECT cron.alter_job(476, schedule := '7-59/10 * * * *'); SELECT cron.alter_job(474, schedule := '9-59/10 * * * *');

CREATE OR REPLACE FUNCTION public.promote_unmapped_sales(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_eligible     integer := 0;
  v_promoted     integer := 0;
  v_dedup        integer := 0;
  v_merged       integer := 0;
  v_blocked      integer := 0;
  v_still_unres  integer := 0;
  v_archived     integer := 0;
  v_ok           boolean := true;
  v_run          jsonb;
  v_started_at   timestamptz := clock_timestamp();
  v_last_run_at  timestamptz;
  -- Minimum gap between two REAL drains of the same scope (2026-08-30).
  c_min_gap      constant interval := interval '20 minutes';
  -- Mirrors the hardcoded constant in allday_sales_cross_source_dedup(). That
  -- BEFORE INSERT trigger is the ONLY insert-suppressing trigger on
  -- public.sales, and it fires for this collection alone.
  c_allday       constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  -- 2026-11-23: the gap is PER SCOPE. c_min_gap was sized for All Day's 104,908-row unresolved scan
  -- (above); a Top Shot drain is 1-2 s over an open backlog of 5-18 rows, and its 20-min gap is
  -- what held Top Shot's on-chain sale-ingest p90 at ~25 min after jobs 476/474 moved to every 10 min
  -- (20261123185838; read 11-23 1:03 PM PT: p50 3.8, p90 24.8, n 129). Top Shot drains every 5 min;
  -- every other scope keeps 20.
  v_min_gap      interval := CASE WHEN p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                                  THEN interval '5 minutes' ELSE c_min_gap END;
BEGIN
  -- ── CONCURRENCY GUARD (2026-08-29) ─────────────────────────────────────────
  -- This drain is NOT claim-based: the `candidates` CTE selects `resolved_at IS
  -- NULL ... LIMIT 1000` with no FOR UPDATE SKIP LOCKED and no in-flight marker,
  -- so two concurrent instances pick the SAME rows and both do the whole scan.
  -- The work is idempotent (ON CONFLICT DO NOTHING + `AND us.resolved_at IS
  -- NULL`), so an overlap is SAFE -- it is simply 100% duplicated IO on an
  -- instance whose binding constraint is disk IO.
  -- Measured 24 h to 2026-08-29 13:25Z: 307 runs, avg gap 278 s, p95 duration
  -- 196,353 ms, max 297,164 ms, and **76 runs still executing when the next one
  -- started -- 74 of them the same collection against itself**.
  -- ⚠ The key is SCOPED TO p_collection_id on purpose: `nfl_all_day` (229 runs,
  -- avg 65,864 ms) and `laliga_golazos` (78 runs, avg 959 ms) touch disjoint
  -- rows and must NOT serialise against each other. Golazos recorded ZERO
  -- overlaps; a function-wide key would have made it wait on AllDay for nothing.
  -- ⛔ KNOWN GAP, stated rather than hidden: an all-collections call
  -- (p_collection_id IS NULL) overlaps every scoped call and this key does not
  -- see that. There were ZERO such calls in the measured window, and all eight
  -- repo call sites pass an explicit collection id.
  IF NOT pg_try_advisory_xact_lock(
       hashtext('promote_unmapped_sales:' || COALESCE(p_collection_id::text, 'ALL'))::bigint) THEN
    -- Record the skip HONESTLY. rows_* are NULL, not 0: nothing was measured,
    -- and `log_pipeline_run` only stopped coalescing NULL to 0 on 2026-08-29
    -- (migration 20260829040000) -- before that this shape was not expressible.
    PERFORM public.log_pipeline_run(
      'promote_unmapped_sales', v_started_at,
      p_rows_found := NULL,
      p_rows_written := NULL,
      p_rows_skipped := NULL,
      p_ok := true,
      p_collection_slug := (SELECT slug FROM public.collections WHERE id = p_collection_id),
      p_extra := jsonb_build_object(
        'note', 'skipped_concurrent_run',
        'scope', COALESCE(p_collection_id::text, 'ALL'))
    );
    -- Explicit NULLs rather than absent keys so a caller inspecting the object
    -- can tell a skip from a drain of nothing. ⚠ app/api/admin/recover-v1-budget-
    -- exhausted/route.ts reads `pr?.promoted ?? 0`, so it still sees 0 either
    -- way; that route is manually invoked and cannot realistically race.
    RETURN jsonb_build_object(
      'skipped', 'concurrent_run',
      'scope', COALESCE(p_collection_id::text, 'ALL'),
      'eligible', NULL,
      'promoted', NULL);
  END IF;

  -- ── MINIMUM GAP (2026-08-30) ───────────────────────────────────────────────
  -- Eight call sites fire this after every ingest tick, and jobid 215 hourly:
  -- measured 24 h to 2026-08-30 14:50Z, nfl_all_day ran 244 times (100 of them
  -- the concurrent-skip above), the 144 real drains averaged 38 s each --
  -- ~1.5 h/day of cron_heavy-class IO -- and promoted 87 sales in total, i.e.
  -- one promotion per minute of scanning. The cost is the `candidates` CTE:
  -- 104,908 unresolved AllDay rows, each probed against nft_edition_map and
  -- the bloated wallet_moments_cache (moment_id, collection_id) index, on
  -- every call, to find the ~0.6 that became resolvable since the last one.
  -- A drain that ran less than c_min_gap ago is skipped for this scope. The
  -- ingest cadence is 20 min, so a promotable sale still lands within one
  -- ingest interval; what changes is that the 10-min history backfill's and
  -- the hourly job's calls no longer each pay the full scan. Scoped like the
  -- lock: golazos does not wait on AllDay. Recorded honestly as a skip row
  -- (rows_* NULL) with the previous run's timestamp so the gap is auditable.
  SELECT s.last_run_at INTO v_last_run_at
    FROM public.promote_unmapped_sales_state s
   WHERE s.scope = COALESCE(p_collection_id::text, 'ALL');
  IF v_last_run_at IS NOT NULL AND v_last_run_at > v_started_at - v_min_gap THEN
    PERFORM public.log_pipeline_run(
      'promote_unmapped_sales', v_started_at,
      p_rows_found := NULL,
      p_rows_written := NULL,
      p_rows_skipped := NULL,
      p_ok := true,
      p_collection_slug := (SELECT slug FROM public.collections WHERE id = p_collection_id),
      p_extra := jsonb_build_object(
        'note', 'skipped_recent_run',
        'scope', COALESCE(p_collection_id::text, 'ALL'),
        'last_run_at', to_char(v_last_run_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
        'min_gap_seconds', EXTRACT(epoch FROM v_min_gap)::integer)
    );
    RETURN jsonb_build_object(
      'skipped', 'recent_run',
      'scope', COALESCE(p_collection_id::text, 'ALL'),
      'last_run_at', v_last_run_at,
      'eligible', NULL,
      'promoted', NULL);
  END IF;
  INSERT INTO public.promote_unmapped_sales_state (scope, last_run_at)
  VALUES (COALESCE(p_collection_id::text, 'ALL'), v_started_at)
  ON CONFLICT (scope) DO UPDATE SET last_run_at = EXCLUDED.last_run_at;

  WITH candidates AS (
    SELECT us.id, us.collection_id, us.nft_id, us.resolution_hint,
           us.price_usd, us.price_native, us.currency,
           us.seller_address, us.buyer_address, us.marketplace,
           us.transaction_hash, us.block_height, us.sold_at,
           us.serial_number, us.source
    FROM public.unmapped_sales us
    WHERE us.resolved_at IS NULL
      -- Skip price-uncertain rows: V1 Dapper sales whose tx-decode budget was
      -- exhausted land here with price_usd = 0 (NOT NULL), so the guard must be
      -- "> 0", not just "IS NOT NULL". A 0/NULL-price sale must never enter
      -- public.sales -- it pollutes FMV. They wait here until a real price is
      -- recovered (decodeV1SaleTx re-run), then promote on a later run.
      AND COALESCE(us.price_usd, 0) > 0
      AND (p_collection_id IS NULL OR us.collection_id = p_collection_id)
      -- FIX 2: attempted-marker skip. Rows proven un-promotable (see mark_blocked)
      -- carry a recheck horizon; do not re-examine them until it passes.
      AND NOT (us.resolution_hint ? 'promote_recheck_after'
               AND (us.resolution_hint->>'promote_recheck_after')::timestamptz > now())
      AND (
        EXISTS (
          SELECT 1 FROM public.nft_edition_map nem
          WHERE nem.collection_id = us.collection_id AND nem.nft_id = us.nft_id
        )
        OR (us.resolution_hint ? 'edition_id'
            AND EXISTS (SELECT 1 FROM public.editions e
                        WHERE e.collection_id = us.collection_id
                          AND e.external_id = us.resolution_hint->>'edition_id'))
        OR (us.resolution_hint ? 'set_id_onchain' AND us.resolution_hint ? 'play_id_onchain'
            AND EXISTS (SELECT 1 FROM public.editions e
                        WHERE e.collection_id = us.collection_id
                          AND e.external_id = (us.resolution_hint->>'set_id_onchain') || ':' || (us.resolution_hint->>'play_id_onchain')))
        -- Path 4 (added 2026-05-24): resolve via wallet_moments_cache.
        OR EXISTS (
          SELECT 1 FROM public.wallet_moments_cache w
          JOIN public.editions e
            ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
          WHERE w.moment_id = us.nft_id AND w.collection_id = us.collection_id
        )
      )
    LIMIT p_limit
  ),
  resolved AS (
    SELECT
      c.*,
      COALESCE(
        (SELECT e.id FROM public.editions e
          WHERE e.collection_id = c.collection_id
            AND c.resolution_hint ? 'set_id_onchain' AND c.resolution_hint ? 'play_id_onchain'
            AND e.external_id = (c.resolution_hint->>'set_id_onchain') || ':' || (c.resolution_hint->>'play_id_onchain')
          LIMIT 1),
        (SELECT e.id FROM public.editions e
          WHERE e.collection_id = c.collection_id
            AND c.resolution_hint ? 'edition_id'
            AND e.external_id = c.resolution_hint->>'edition_id'
          LIMIT 1),
        (SELECT e.id
           FROM public.nft_edition_map nem
           JOIN public.editions e
             ON e.collection_id = nem.collection_id AND e.external_id = nem.edition_external_id
          WHERE nem.collection_id = c.collection_id AND nem.nft_id = c.nft_id
          LIMIT 1),
        (SELECT e.id
           FROM public.wallet_moments_cache w
           JOIN public.editions e
             ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
          WHERE w.moment_id = c.nft_id AND w.collection_id = c.collection_id
          LIMIT 1)
      ) AS edition_id,
      COALESCE(
        (SELECT nem.serial_number FROM public.nft_edition_map nem
          WHERE nem.collection_id = c.collection_id AND nem.nft_id = c.nft_id
          LIMIT 1),
        (SELECT w.serial_number FROM public.wallet_moments_cache w
          WHERE w.moment_id = c.nft_id AND w.collection_id = c.collection_id
          LIMIT 1)
      ) AS map_serial
    FROM candidates c
  ),
  resolved_with_edition AS (
    SELECT * FROM resolved WHERE edition_id IS NOT NULL
  ),
  inserted AS (
    INSERT INTO public.sales (
      moment_id, edition_id, collection_id, serial_number,
      price_usd, price_native, currency,
      seller_address, buyer_address, marketplace,
      transaction_hash, block_height, sold_at, nft_id, collection, source
    )
    SELECT
      NULL,
      r.edition_id,
      r.collection_id,
      COALESCE(r.serial_number, r.map_serial, 0),
      r.price_usd, r.price_native, COALESCE(r.currency, 'USD'),
      r.seller_address, r.buyer_address, r.marketplace,
      r.transaction_hash, r.block_height, r.sold_at, r.nft_id,
      (SELECT slug FROM public.collections WHERE id = r.collection_id),
      COALESCE(r.source, 'promoted_from_unmapped')
    FROM resolved_with_edition r
    ON CONFLICT DO NOTHING
    RETURNING transaction_hash, nft_id
  ),
  -- FIX 1: per-row outcome. Note CTEs read the pre-statement snapshot of
  -- public.sales, so the `already_in_sales` test cannot see rows `inserted` just
  -- wrote -- which is exactly right: those are covered by the `promoted` arm.
  classified AS (
    SELECT r.id, r.transaction_hash, r.nft_id,
           CASE
             WHEN EXISTS (SELECT 1 FROM inserted i
                           WHERE i.transaction_hash = r.transaction_hash
                             AND i.nft_id IS NOT DISTINCT FROM r.nft_id)
               THEN 'promoted'
             WHEN EXISTS (SELECT 1 FROM public.sales s
                           WHERE s.transaction_hash = r.transaction_hash
                             AND s.nft_id IS NOT DISTINCT FROM r.nft_id)
               THEN 'already_in_sales'
             -- FIX 4 (2026-07-31): the insert was SUPPRESSED, not rejected.
             -- trg_zzz_allday_cross_source_dedup found a cross-source economic
             -- twin, merged this row's buyer/seller/serial into it and RETURN
             -- NULLed -- silently, with no error and no inserted row. The sale
             -- IS recorded, on the twin under a different tx_hash, so this
             -- staging row is resolved in substance. Predicate mirrors the
             -- trigger's guard + economic key exactly, including the source
             -- COALESCE the INSERT above applies.
             WHEN r.collection_id = c_allday
                  AND r.nft_id IS NOT NULL
                  AND r.price_usd IS NOT NULL
                  AND r.sold_at IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.sales s
                               WHERE s.collection_id = c_allday
                                 AND s.nft_id = r.nft_id
                                 AND date_trunc('day', s.sold_at) = date_trunc('day', r.sold_at)
                                 AND round(s.price_usd::numeric, 2) = round(r.price_usd::numeric, 2)
                                 AND s.source IS DISTINCT FROM COALESCE(r.source, 'promoted_from_unmapped'))
               THEN 'merged_cross_source'
             -- Nothing inserted, and none of the three explanations hold. Since
             -- the 2026-07-31 index widening a same-tx different-nft row IS
             -- storable, so this is no longer a tx-hash collision -- it is an
             -- unexplained disappearance, and saying so is the honest signal.
             ELSE 'insert_vanished'
           END AS outcome
      FROM resolved_with_edition r
  ),
  mark_done AS (
    UPDATE public.unmapped_sales us
       SET resolved_at = now()
      FROM classified c
     WHERE us.id = c.id
       AND us.resolved_at IS NULL
       AND c.outcome IN ('promoted', 'already_in_sales', 'merged_cross_source')
    RETURNING us.id, c.outcome
  ),
  mark_blocked AS (
    UPDATE public.unmapped_sales us
       SET resolution_hint = COALESCE(us.resolution_hint, '{}'::jsonb)
             || jsonb_build_object(
                  'promote_blocked', 'sales_insert_vanished_unexplained',
                  'promote_blocked_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
                  'promote_recheck_after', to_char(now() + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SSOF'))
      FROM classified c
     WHERE us.id = c.id
       AND us.resolved_at IS NULL
       AND c.outcome = 'insert_vanished'
    RETURNING us.id
  )
  SELECT
    (SELECT count(*) FROM classified),
    (SELECT count(*) FROM mark_done WHERE outcome = 'promoted'),
    (SELECT count(*) FROM mark_done WHERE outcome = 'already_in_sales'),
    (SELECT count(*) FROM mark_done WHERE outcome = 'merged_cross_source'),
    (SELECT count(*) FROM mark_blocked)
  INTO v_eligible, v_promoted, v_dedup, v_merged, v_blocked;

  SELECT count(*) INTO v_still_unres
  FROM public.unmapped_sales
  WHERE resolved_at IS NULL
    AND (p_collection_id IS NULL OR collection_id = p_collection_id);

  -- fmv_from_sales() call removed 2026-05-25: it was a retired no-op since
  -- 2026-05-24. fmv-recalc '1.7.0' is the sole sales-path FMV owner; promoted
  -- sales self-heal as fmv-recalc's sweep reaches them.

  WITH del AS (
    DELETE FROM public.unmapped_sales
    WHERE resolved_at IS NOT NULL
      AND resolved_at < now() - interval '7 days'
      AND (p_collection_id IS NULL OR collection_id = p_collection_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_archived FROM del;

  -- FIX 3: honest signal. Only the true silent-failure signature reds the run:
  -- there was work to do and absolutely nothing changed.
  IF v_eligible > 0 AND v_promoted = 0 AND v_dedup = 0 AND v_merged = 0 AND v_blocked = 0 THEN
    v_ok := false;
  END IF;

  v_run := jsonb_build_object(
    'eligible', v_eligible,
    'promoted', v_promoted,
    'deduped_already_in_sales', v_dedup,
    'merged_cross_source', v_merged,
    'blocked_insert_vanished', v_blocked,
    'still_unresolved', v_still_unres,
    'open_backlog', v_still_unres,
    'resolve_ratio', CASE WHEN v_eligible > 0
                          THEN round(v_promoted::numeric / v_eligible, 4)
                          ELSE NULL END,
    'archived', v_archived,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::integer
  );

  PERFORM public.log_pipeline_run(
    'promote_unmapped_sales', v_started_at,
    p_rows_found := v_eligible,
    p_rows_written := v_promoted,
    p_ok := v_ok,
    p_collection_slug := (SELECT slug FROM public.collections WHERE id = p_collection_id),
    p_extra := v_run
  );

  RETURN v_run;
END;
$function$;

SELECT cron.alter_job(476, schedule := '1-59/5 * * * *');
SELECT cron.alter_job(474, schedule := '3-59/5 * * * *');
