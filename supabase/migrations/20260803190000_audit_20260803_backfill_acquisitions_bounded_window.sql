-- public.backfill_acquisitions_for_collection — add an optional `p_since` window
-- so the candidate scan stops grinding fully-drained history.
--
-- DEFECT (measured live 2026-08-03). The `candidates` CTE drives off
-- `sales WHERE collection_id = $1 AND price_usd > 0`, and the partitioned Append
-- walks partitions OLDEST-FIRST via bitmap heap scans (which cannot stream). For
-- All Day that is 735,818 rows, of which:
--
--   2025 candidates: 0        (proven — the count returns instantly)
--   2024 candidates: unknown  (the COUNT itself times out proving it empty)
--   2026 candidates: 168      (all of the real work)
--   last 7 days:     23
--
-- So the scan spends its entire 90s budget proving that 2022-2025 (~612k rows,
-- long since classified) has nothing in it, and dies BEFORE reaching the 2026
-- partition where every real candidate lives. `LIMIT p_limit` cannot save it —
-- the limit only stops the scan once it has FOUND p_limit rows, and it finds
-- almost none until the very end. This is why lowering p_limit (the fix the old
-- route comment prescribed) does nothing: measured `processed` per tick runs
-- 0,1,3,9,20,35 against p_limit=80, so the limit almost never binds.
--
-- Symptom chain: the All Day leg burns the fn's 90s `statement_timeout`, which
-- pushes the route's 3-collection after() loop past its 120s maxDuration, so the
-- lambda is killed BEFORE log_pipeline_run — leaving no pipeline_runs row. That
-- reads as a missing cron trigger (runs/day 24 -> ~9) when it is really a slow
-- query. It degrades monotonically: cost is bound by the size of All Day `sales`,
-- which only grows.
--
-- FIX: an optional `p_since timestamptz DEFAULT NULL` predicate on `sold_at`.
-- NULL preserves the current unbounded semantics exactly, so every existing
-- caller and both other collections are byte-for-byte unaffected; only the All
-- Day target passes a window. Bounding by sold_at lets the planner prune whole
-- partitions instead of proving them empty row by row.
--
-- Deliberately NOT done: (a) a `sales(collection_id, nft_id)` composite index —
-- it would tax the hot sales ingest path to speed up a once-hourly janitor;
-- (b) raising the fn's 90s statement_timeout — the 120s lambda is the binding
-- budget, so raising it only converts a logged error into a SILENT kill. Both
-- probe sides are already correctly indexed (idx_moment_acquisitions_nft_id,
-- idx_wmc_moment_collection_cover) — the driving scan was always the cost.
--
-- The old 2-arg signature is DROPPED rather than left alongside: PostgREST
-- resolves overloads by the set of named arguments, so a 2-named-arg .rpc() call
-- would match BOTH the 2-arg function and the 3-arg one (whose third arg is
-- defaulted) and 300 with "could not choose the best candidate function".
-- Verified 2026-08-03 that the route is the ONLY caller — no other function
-- body, no cron.job command, and no in-repo reference besides it.
--
-- Revert:
--   DROP FUNCTION public.backfill_acquisitions_for_collection(uuid, integer, timestamptz);
-- then re-apply the prior 2-arg body from
--   supabase/migrations/... (or pg_get_functiondef captured in the ledger entry).

DROP FUNCTION IF EXISTS public.backfill_acquisitions_for_collection(uuid, integer);

CREATE OR REPLACE FUNCTION public.backfill_acquisitions_for_collection(
  p_collection_id uuid,
  p_limit integer DEFAULT 500,
  p_since timestamptz DEFAULT NULL
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_processed int := 0;
BEGIN
  WITH candidates AS (
    SELECT s.nft_id, s.collection_id, s.price_usd, s.sold_at,
           s.seller_address, s.transaction_hash, s.edition_id
    FROM sales s
    WHERE s.collection_id = p_collection_id
      AND s.price_usd > 0
      -- Bounded window; NULL keeps the historical unbounded behaviour.
      -- MUST be written as a plain sargable comparison against COALESCE, NOT as
      -- `(p_since IS NULL OR s.sold_at >= p_since)`. The OR-form is non-sargable:
      -- the planner cannot use sales_YYYY_collection_id_sold_at_idx or prune
      -- partitions through it, so it falls back to the same oldest-first bitmap
      -- heap scans over every partition and the window buys nothing (measured:
      -- OR-form 42.9s vs COALESCE-form 3.5s on a 14d window, and the COALESCE
      -- plan reports `Subplans Removed: 6` — 6 of 8 partitions pruned outright).
      AND s.sold_at >= COALESCE(p_since, '-infinity'::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = s.nft_id
      )
      AND EXISTS (
        SELECT 1 FROM wallet_moments_cache wmc
        WHERE wmc.moment_id = s.nft_id
          AND wmc.collection_id = s.collection_id
      )
    LIMIT p_limit
  ),
  latest_per_nft AS (
    SELECT DISTINCT ON (c.nft_id) c.*
    FROM candidates c
    ORDER BY c.nft_id, c.sold_at DESC
  ),
  resolved AS (
    SELECT lpn.*, wmc.wallet_address AS wallet,
           (SELECT fs.fmv_usd FROM fmv_snapshots fs
            WHERE fs.edition_id = lpn.edition_id
            ORDER BY fs.computed_at DESC LIMIT 1) AS fmv
    FROM latest_per_nft lpn
    JOIN wallet_moments_cache wmc
      ON wmc.moment_id = lpn.nft_id
      AND wmc.collection_id = lpn.collection_id
  ),
  inserted AS (
    INSERT INTO moment_acquisitions (
      nft_id, wallet, buy_price, acquired_date, acquired_type,
      acquisition_method, acquisition_confidence,
      fmv_at_acquisition, seller_address, transaction_hash,
      source, collection_id
    )
    SELECT
      nft_id, wallet, price_usd, sold_at, 1,
      'marketplace', 'heuristic',
      fmv, seller_address,
      COALESCE(transaction_hash, 'backfill:' || nft_id),
      'sales_join_wmc', collection_id
    FROM resolved
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING 1
  ),
  counts AS (
    SELECT
      (SELECT COUNT(*) FROM inserted) AS ins,
      (SELECT COUNT(*) FROM resolved) AS proc
  )
  SELECT ins, proc FROM counts INTO v_inserted, v_processed;

  RETURN json_build_object(
    'collection_id', p_collection_id,
    'processed', v_processed,
    'inserted', v_inserted,
    'since', p_since
  );
END;
$function$;

COMMENT ON FUNCTION public.backfill_acquisitions_for_collection(uuid, integer, timestamptz) IS
  'Classifies marketplace acquisitions for non-TopShot collections by joining sales to wallet_moments_cache. p_since bounds the candidate scan by sold_at (NULL = unbounded); All Day MUST pass a window or the scan grinds ~612k fully-classified 2022-2025 rows and times out before reaching current data. See audit_20260803_backfill_acquisitions_bounded_window.';
