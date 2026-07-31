-- promote_unmapped_sales(): stop mislabelling trigger-suppressed rows as
-- "tx_hash_collision".
--
-- Background. Until 2026-07-31 the unique index on public.sales was tx_hash-only,
-- so a multi-item transaction genuinely could not be stored and the drainer's
-- ELSE arm ("nothing inserted, no same-tx+same-nft row exists") really did mean
-- a tx-hash collision. Commit aa609eb1 widened that index to
-- (transaction_hash, nft_id, sold_at) NULLS NOT DISTINCT, so that class is gone:
-- v_sales_tx_collision_loss reports 0 rows with cause='tx_hash_index_collision'.
--
-- What the ELSE arm now catches is a DIFFERENT, benign thing. public.sales
-- carries exactly one insert-suppressing trigger, trg_zzz_allday_cross_source_dedup
-- (BEFORE INSERT, AllDay only). On finding a cross-source economic twin -- same
-- nft_id, same calendar day, same rounded price, DIFFERENT source -- it merges
-- the incoming buyer/seller/serial into the surviving twin and RETURN NULLs.
-- No error is raised and zero rows insert, so the staging row matched neither
-- the `promoted` arm nor the `already_in_sales` arm (which tests same-tx AND
-- same-nft, and the twin carries a different tx) and fell through to ELSE. It
-- was then parked for 30 days by the promote_recheck_after horizon and would
-- recycle forever -- exactly as the real collisions used to.
--
-- Observed 2026-07-31: 3 AllDay rows ($273) re-marked at 16:01:42Z by a promote
-- run AFTER the index fix; each has 0 rows in sales sharing its tx_hash and
-- exactly 1 cross-source dedup twin. The sale IS recorded, on the twin.
--
-- Fix: a fourth outcome. `merged_cross_source` mirrors the trigger's predicate
-- exactly and is treated as RESOLVED (resolved_at = now()), because the sale is
-- recorded in substance. The ELSE arm survives but now asserts what it actually
-- means -- `insert_vanished`, an unexplained disappearance -- and its marker
-- string / run key are renamed to match. Every other line of the function is
-- byte-identical to 20260727170000.
--
-- Also clears the three stale `sales_tx_hash_unique_collision` markers so the
-- next tick reclassifies them (the 30-day recheck horizon would otherwise keep
-- them out of the candidate CTE until 2026-08-30).
--
-- Revert:
--   re-apply the promote_unmapped_sales DDL from
--   supabase/migrations/20260727170000_audit_20260727_unmapped_sales_onchain_attempt_cursor.sql
--   (the marker clear is not worth reverting -- markers are re-derivable).

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
  -- Mirrors the hardcoded constant in allday_sales_cross_source_dedup(). That
  -- BEFORE INSERT trigger is the ONLY insert-suppressing trigger on
  -- public.sales, and it fires for this collection alone.
  c_allday       constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
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
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started_at))::integer
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

-- The tx-hash-collision class no longer exists (idx_sales_tx_nft_sold, aa609eb1),
-- so every surviving marker is stale by construction. Clearing it (and the
-- 30-day recheck horizon it carries) lets the next tick reclassify these rows
-- through the new `merged_cross_source` arm instead of leaving them parked.
UPDATE public.unmapped_sales
   SET resolution_hint = resolution_hint - 'promote_blocked' - 'promote_blocked_at' - 'promote_recheck_after'
 WHERE resolved_at IS NULL
   AND resolution_hint->>'promote_blocked' = 'sales_tx_hash_unique_collision';
