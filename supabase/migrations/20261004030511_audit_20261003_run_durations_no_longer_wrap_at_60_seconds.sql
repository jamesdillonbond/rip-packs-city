-- audit_20261003_run_durations_no_longer_wrap_at_60_seconds
--
-- 2026-10-03 (PT, Claude Code cloud). Closes known-issues #147.
--
-- WHAT. Seven functions logged a run's duration with EXTRACT(MILLISECOND[S] FROM <interval>), which
-- returns only the SECONDS FIELD x 1000 (0..59,999): a 61 s run logged ~1,000 ms. Each now uses
-- (EXTRACT(EPOCH FROM <interval>) * 1000), the whole interval in ms. drain_fmv_cold_tail also measured
-- from NOW() (the transaction start) on BOTH ends, so its elapsed_ms read ~0 whatever the run took; it
-- now measures clock_timestamp() - v_started_at (v_started_at is still NOW(), the run's start).
--
-- WHY NOW. #147 was filed latent (every affected run < 60 s over 72 h, re-checked 2026-10-03: still
-- none >= 60 s). Trevor 2026-10-03: "don't leave anything unresolved". Nothing else in any body changes.
--
-- HOW, two shapes, no hand transcription of a live body:
--   * LITERAL DDL for the four whose newest committed body is BYTE-IDENTICAL to live prosrc (md5 checked
--     before writing this file): drain_fmv_cold_tail (base 20261004002116), promote_unmapped_sales
--     (20260830150207, pinned), prune_stale_wmc (20260815203700, pinned), recalc_ultimate_fmv
--     (20260729000000, pinned). Each block below is that committed block with the one expression replaced.
--   * md5-GUARDED SPLICE of pg_get_functiondef() for the three whose live body differs from every committed
--     copy (later live edits): backfill_pack_pull_source_rip_id, discover_and_seed_active_wallets,
--     run_weekly_log_purges. Each refuses to run unless the live body md5 is the reviewed base and the
--     expression occurs the expected number of times.
--
-- POST-APPLY md5 of prosrc (literal four): drain_fmv_cold_tail 54b87a10fa45a1c012be6ea19c471950 · promote_unmapped_sales be9ba6155972afdb7018f940db498d1c · prune_stale_wmc dca942b93fe7f49817e3b50c21e4b18b · recalc_ultimate_fmv 7d2fddb35cc6bad9b21da95f302ea3c0
--
-- anon-exec: unchanged (revoked; anon=false, authenticated=false verified live 2026-10-03) — CREATE OR REPLACE preserves the ACL (drain_fmv_cold_tail)
-- anon-exec: unchanged (revoked; anon=false, authenticated=false verified live 2026-10-03) — CREATE OR REPLACE preserves the ACL (promote_unmapped_sales)
-- anon-exec: unchanged (revoked; anon=false, authenticated=false verified live 2026-10-03) — CREATE OR REPLACE preserves the ACL (prune_stale_wmc)
-- anon-exec: unchanged (revoked; anon=false, authenticated=false verified live 2026-10-03) — CREATE OR REPLACE preserves the ACL (recalc_ultimate_fmv)
-- anon-exec: unchanged (revoked; anon=false, authenticated=false verified live 2026-10-03) — CREATE OR REPLACE preserves the ACL (backfill_pack_pull_source_rip_id)
-- anon-exec: unchanged (revoked; anon=false, authenticated=false verified live 2026-10-03) — CREATE OR REPLACE preserves the ACL (discover_and_seed_active_wallets)
-- anon-exec: unchanged (revoked; anon=false, authenticated=false verified live 2026-10-03) — CREATE OR REPLACE preserves the ACL (run_weekly_log_purges)
--
-- REVERT: re-apply each literal block from its base migration named above; for the three spliced
-- functions, re-apply this file's splice with the two strings swapped.

-- ── drain_fmv_cold_tail (base: 20261004002116_audit_20261003_fmv_readers_exclude_buyback_wallets.sql) ──
CREATE OR REPLACE FUNCTION public.drain_fmv_cold_tail(p_collection_slug text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_collection_id   UUID;
  v_processed       INT := 0;
  v_with_sales      INT := 0;
  v_no_data         INT := 0;
  v_ask_only        INT := 0;
  v_stale           INT := 0;
  v_started_at      TIMESTAMPTZ := NOW();
  v_edition_row     RECORD;
  v_median          NUMERIC;
  v_floor           NUMERIC;
  v_ask_floor       NUMERIC;
  v_sales_count_30d INT;
  v_sales_count_7d  INT;
  v_days_since_sale INT;
  v_confidence      TEXT;
  v_hist_median     NUMERIC;
  v_hist_floor      NUMERIC;
  v_hist_last       TIMESTAMPTZ;
  v_hist_n          INT;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;

  IF v_collection_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unknown collection', 'collection_slug', p_collection_slug);
  END IF;

  FOR v_edition_row IN
    WITH latest AS (
      SELECT edition_id, MAX(computed_at) AS last_snapshot
      FROM fmv_snapshots
      -- SCOPED 2026-08-26. Without this the aggregate grouped EVERY snapshot
      -- in the table (~1.28M rows, 66,499 buffers, 38.6 s) to answer a question
      -- about one collection's editions. Provably equivalent: 0 of 1,281,003
      -- snapshots carry a collection_id that differs from their edition's.
      -- Served by fmv_snapshots_2026_collection_id_edition_id_computed_at_idx.
      WHERE collection_id = v_collection_id
      GROUP BY edition_id
    ),
    candidates AS (
      SELECT e.id AS edition_id, e.tier, l.last_snapshot AS last_snapshot
      FROM editions e
      LEFT JOIN latest l ON l.edition_id = e.id
      WHERE e.collection_id = v_collection_id
        -- Top-Shot-ONLY phantom guard (scoped 2026-08-17).
        AND NOT (
          v_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
          AND e.external_id LIKE '%-%'
          AND e.set_id_onchain IS NULL
        )
    )
    SELECT edition_id, tier, last_snapshot
    FROM candidates
    WHERE last_snapshot IS NULL OR last_snapshot < NOW() - INTERVAL '7 days'
    ORDER BY
      CASE tier WHEN 'ULTIMATE' THEN 1 WHEN 'LEGENDARY' THEN 2 WHEN 'RARE' THEN 3
                WHEN 'COMMON' THEN 4 WHEN 'FANDOM' THEN 5 ELSE 6 END,
      last_snapshot NULLS FIRST
    LIMIT p_limit
  LOOP
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_usd),
      MIN(price_usd),
      COUNT(*),
      COUNT(*) FILTER (WHERE sold_at > NOW() - INTERVAL '7 days'),
      EXTRACT(DAY FROM NOW() - MAX(sold_at))::INT
    INTO v_median, v_floor, v_sales_count_30d, v_sales_count_7d, v_days_since_sale
    FROM public.sales_market
    WHERE edition_id = v_edition_row.edition_id
      AND sold_at > NOW() - INTERVAL '30 days'
      AND price_usd > 0;

    v_sales_count_30d := COALESCE(v_sales_count_30d, 0);
    v_sales_count_7d  := COALESCE(v_sales_count_7d, 0);

    IF v_sales_count_30d = 0 THEN
      -- All Day: the live, ghost-filtered floor (20260923 re-point). No live ask => NULL
      -- => falls through to STALE / NO_DATA below, never a price from a gone ask.
      IF v_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
        SELECT f.floor_ask INTO v_ask_floor
        FROM allday_edition_floor_ask f
        WHERE f.edition_id = v_edition_row.edition_id
          AND f.floor_ask > 0 AND f.floor_ask <= 10000;
      ELSE
      SELECT b.low_ask INTO v_ask_floor
        FROM editions e
        JOIN badge_editions b
          ON b.external_id = e.external_id AND b.collection_id = e.collection_id
        WHERE e.id = v_edition_row.edition_id
          AND b.low_ask > 0 AND b.low_ask <= 10000
        ORDER BY b.low_ask ASC
        LIMIT 1;
      END IF;

      IF v_ask_floor IS NOT NULL THEN
        INSERT INTO fmv_snapshots (
          edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
          confidence, sales_count_7d, sales_count_30d,
          algo_version, computed_at, collection
        ) VALUES (
          v_edition_row.edition_id, v_collection_id,
          ROUND(v_ask_floor * 0.90, 2), ROUND(v_ask_floor, 2), NULL,
          'ASK_ONLY', 0, 0, 'cold-tail-1.0', NOW(), p_collection_slug
        );
        v_ask_only := v_ask_only + 1;
      ELSE
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY h.price_usd),
               MIN(h.price_usd), MAX(h.sold_at), COUNT(*)
        INTO v_hist_median, v_hist_floor, v_hist_last, v_hist_n
        FROM (
          -- 2026-09-25 (#140): the last 30 paid sales, KEPT only where they sit
          -- within 90 days of the edition's newest sale -- but never fewer than
          -- its 3 most recent. Identical to fmv_recalc_historical_candidates.
          SELECT r.price_usd, r.sold_at
          FROM (
            SELECT l.price_usd, l.sold_at,
                   row_number() OVER (ORDER BY l.sold_at DESC) AS rn,
                   max(l.sold_at) OVER () AS newest
            FROM (
              SELECT price_usd, sold_at FROM public.sales_market
              WHERE edition_id = v_edition_row.edition_id AND price_usd > 0
              ORDER BY sold_at DESC LIMIT 30
            ) l
          ) r
          WHERE r.rn <= 3 OR r.sold_at >= r.newest - INTERVAL '90 days'
        ) h;

        IF COALESCE(v_hist_n, 0) > 0 THEN
          INSERT INTO fmv_snapshots (
            edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, asp_without_outliers,
            confidence, sales_count_7d, sales_count_30d, days_since_sale,
            algo_version, computed_at, collection
          ) VALUES (
            v_edition_row.edition_id, v_collection_id,
            ROUND(v_hist_median, 2), ROUND(v_hist_floor, 2), ROUND(v_hist_median, 2), ROUND(v_hist_median, 2),
            'STALE', 0, 0, EXTRACT(DAY FROM NOW() - v_hist_last)::INT,
            'cold-tail-1.0', NOW(), p_collection_slug
          );
          v_stale := v_stale + 1;
        ELSE
          INSERT INTO fmv_snapshots (
            edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
            confidence, sales_count_7d, sales_count_30d,
            algo_version, computed_at, collection
          ) VALUES (
            v_edition_row.edition_id, v_collection_id, NULL, NULL, NULL,
            'NO_DATA', 0, 0, 'cold-tail-1.0', NOW(), p_collection_slug
          );
          v_no_data := v_no_data + 1;
        END IF;
      END IF;
    ELSE
      IF v_sales_count_30d >= 5    THEN v_confidence := 'SALES_ONLY';
      ELSIF v_sales_count_30d >= 2 THEN v_confidence := 'LOW';
      ELSE                              v_confidence := 'LOW';
      END IF;

      INSERT INTO fmv_snapshots (
        edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, asp_without_outliers,
        confidence, sales_count_7d, sales_count_30d, days_since_sale,
        algo_version, computed_at, collection
      ) VALUES (
        v_edition_row.edition_id, v_collection_id,
        ROUND(v_median, 2), ROUND(v_floor, 2), ROUND(v_median, 2), ROUND(v_median, 2),
        v_confidence::fmv_confidence,
        v_sales_count_7d, v_sales_count_30d, v_days_since_sale,
        'cold-tail-1.0', NOW(), p_collection_slug
      );
      v_with_sales := v_with_sales + 1;
    END IF;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'collection_slug', p_collection_slug,
    'processed',       v_processed,
    'with_sales',      v_with_sales,
    'stale',           v_stale,
    'ask_only',        v_ask_only,
    'no_data',         v_no_data,
    'elapsed_ms',      (EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at)) * 1000)::INT,
    'started_at',      v_started_at,
    'threshold_days',  7
  );
END;
$function$;

-- ── promote_unmapped_sales (base: 20260830150207_audit_20260830_promote_unmapped_sales_minimum_gap_between_drains.sql) ──
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
  IF v_last_run_at IS NOT NULL AND v_last_run_at > v_started_at - c_min_gap THEN
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
        'min_gap_seconds', EXTRACT(epoch FROM c_min_gap)::integer)
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

-- ── prune_stale_wmc (base: 20260815203700_audit_20260815_snapshot_prune_stale_wmc.sql) ──
CREATE OR REPLACE FUNCTION public.prune_stale_wmc()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_stale_cache_deleted integer := 0;
  v_wallets_pruned integer := 0;
  v_wallet text;
  v_chunk integer;
BEGIN
  -- Belt-and-suspenders: robust even if invoked by a role with a tighter default
  -- (service_role 30s); cron_heavy already defaults to 600s.
  PERFORM set_config('statement_timeout', '600000', true);

  FOR v_wallet IN
    SELECT DISTINCT w.wallet_address
    FROM public.wallet_moments_cache w
    WHERE w.last_seen_at < now() - interval '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM seeded_wallets sw
        WHERE sw.wallet_address = w.wallet_address
          AND sw.is_active = true
      )
  LOOP
    DELETE FROM public.wallet_moments_cache
    WHERE wallet_address = v_wallet
      AND last_seen_at < now() - interval '14 days';
    GET DIAGNOSTICS v_chunk = ROW_COUNT;
    v_stale_cache_deleted := v_stale_cache_deleted + v_chunk;
    IF v_chunk > 0 THEN
      v_wallets_pruned := v_wallets_pruned + 1;
    END IF;
  END LOOP;

  PERFORM public.log_pipeline_run(
    p_pipeline := 'weekly-wmc-prune',
    p_started_at := v_started,
    p_rows_written := v_stale_cache_deleted,
    p_extra := jsonb_build_object(
      'stale_cache_deleted', v_stale_cache_deleted,
      'wallets_pruned',      v_wallets_pruned
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'stale_cache_deleted', v_stale_cache_deleted,
    'wallets_pruned',      v_wallets_pruned,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::integer
  );
END;
$function$;

-- ── recalc_ultimate_fmv (base: 20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql) ──
CREATE OR REPLACE FUNCTION public.recalc_ultimate_fmv()
 RETURNS TABLE(total_editions integer, inserted integer, no_data integer, ask_only integer, sales_only integer, min_sale_ask integer, ran_at timestamp with time zone, duration_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total int := 0;
  v_inserted int := 0;
  v_no_data int := 0;
  v_ask_only int := 0;
  v_sales_only int := 0;
  v_min int := 0;
  v_start timestamptz := clock_timestamp();
  v_ran timestamptz := now();
  v_finish timestamptz;
  v_dur int;
BEGIN
  DELETE FROM fmv_snapshots
  WHERE algo_version = 'ultimate-v1'
    AND computed_at >= date_trunc('day', v_ran)
    AND edition_id IN (SELECT id FROM editions WHERE tier = 'ULTIMATE');

  WITH src AS (
    SELECT
      e.id                          AS ed_id,
      r.collection_id               AS coll_id,
      r.collection_slug             AS coll_slug,
      r.fmv_usd                     AS fmv,
      r.lowest_non_special_ask      AS low_ask,
      r.confidence                  AS conf,
      r.days_since_sale             AS days,
      r.source                      AS src_kind
    FROM editions e
    LEFT JOIN LATERAL compute_ultimate_non_special_fmv(e.id) r ON true
    WHERE e.tier = 'ULTIMATE'
  ),
  ins AS (
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, collection,
      fmv_usd, floor_price_usd, ask_proxy_fmv,
      confidence, days_since_sale,
      algo_version, computed_at
    )
    SELECT
      s.ed_id, s.coll_id, s.coll_slug,
      s.fmv, s.low_ask, s.low_ask,
      s.conf::fmv_confidence, s.days,
      'ultimate-v1', v_ran
    FROM src s
    WHERE s.fmv IS NOT NULL
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::int FROM src),
    (SELECT COUNT(*)::int FROM ins),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'no_data'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'ask_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'sale_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'min_sale_ask')
  INTO v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min;

  v_finish := clock_timestamp();
  v_dur := (EXTRACT(EPOCH FROM (v_finish - v_start)) * 1000)::int;

  INSERT INTO pipeline_runs (
    pipeline, started_at, finished_at,
    rows_found, rows_written, rows_skipped, ok, extra
  )
  VALUES (
    'ultimate-fmv-recalc-v1', v_start, v_finish,
    v_total, v_inserted, v_no_data, true,
    jsonb_build_object(
      'algo_version', 'ultimate-v1',
      'no_data', v_no_data,
      'ask_only', v_ask_only,
      'sales_only', v_sales_only,
      'min_sale_ask', v_min,
      'duration_ms', v_dur
    )
  );

  RETURN QUERY SELECT v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min, v_ran, v_dur;
END;
$function$;

DO $mig$
DECLARE v_def text; v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosrc INTO v_def, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'backfill_pack_pull_source_rip_id';
  IF v_src IS NULL THEN RAISE EXCEPTION 'backfill_pack_pull_source_rip_id not found'; END IF;
  IF md5(v_src) <> 'd5ec851345fdab365822dc9c91184bff' THEN RAISE EXCEPTION 'backfill_pack_pull_source_rip_id: live body md5 % is not the reviewed base d5ec851345fdab365822dc9c91184bff', md5(v_src); END IF;
  IF (length(v_src) - length(replace(v_src, 'EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int', ''))) / length('EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int') <> 1 THEN RAISE EXCEPTION 'backfill_pack_pull_source_rip_id: expected 1 occurrence(s)'; END IF;
  v_new := replace(v_def, 'EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int', '(EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::int');
  EXECUTE v_new;
  IF (SELECT position('EXTRACT(milliseconds' in prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'backfill_pack_pull_source_rip_id') <> 0 THEN
    RAISE EXCEPTION 'backfill_pack_pull_source_rip_id: transform did not land';
  END IF;
END
$mig$;

DO $mig$
DECLARE v_def text; v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosrc INTO v_def, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'discover_and_seed_active_wallets';
  IF v_src IS NULL THEN RAISE EXCEPTION 'discover_and_seed_active_wallets not found'; END IF;
  IF md5(v_src) <> '272719afad7f678d79ad0d2b492f9ace' THEN RAISE EXCEPTION 'discover_and_seed_active_wallets: live body md5 % is not the reviewed base 272719afad7f678d79ad0d2b492f9ace', md5(v_src); END IF;
  IF (length(v_src) - length(replace(v_src, 'EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer', ''))) / length('EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer') <> 2 THEN RAISE EXCEPTION 'discover_and_seed_active_wallets: expected 2 occurrence(s)'; END IF;
  v_new := replace(v_def, 'EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer', '(EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::integer');
  EXECUTE v_new;
  IF (SELECT position('EXTRACT(milliseconds' in prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'discover_and_seed_active_wallets') <> 0 THEN
    RAISE EXCEPTION 'discover_and_seed_active_wallets: transform did not land';
  END IF;
END
$mig$;

DO $mig$
DECLARE v_def text; v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosrc INTO v_def, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'run_weekly_log_purges';
  IF v_src IS NULL THEN RAISE EXCEPTION 'run_weekly_log_purges not found'; END IF;
  IF md5(v_src) <> '6ee847b2ec522e9c9e4d2374fe7be022' THEN RAISE EXCEPTION 'run_weekly_log_purges: live body md5 % is not the reviewed base 6ee847b2ec522e9c9e4d2374fe7be022', md5(v_src); END IF;
  IF (length(v_src) - length(replace(v_src, 'EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer', ''))) / length('EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer') <> 1 THEN RAISE EXCEPTION 'run_weekly_log_purges: expected 1 occurrence(s)'; END IF;
  v_new := replace(v_def, 'EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::integer', '(EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::integer');
  EXECUTE v_new;
  IF (SELECT position('EXTRACT(milliseconds' in prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'run_weekly_log_purges') <> 0 THEN
    RAISE EXCEPTION 'run_weekly_log_purges: transform did not land';
  END IF;
END
$mig$;
