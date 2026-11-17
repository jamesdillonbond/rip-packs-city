-- audit_20260907: the edition-verify dispatcher's in-flight check was a per-candidate seq scan — 2.5 s / 306K buffers per tick.
--
-- Found by the tick's own duration (`ts-listings-atlas-sync` extra.duration_ms): 0.5 s at ship,
-- 1.4 s an hour later, 3.3 s two hours later — while the three syncs it wraps summed to ~0.55 s. The
-- ~2.8 s remainder was `atlas_edition_verify_dispatch(2)` (20260907024130): its NOT EXISTS against
-- `topshot_atlas_market_requests` (`q.error = '__edition__' || c.atlas_edition_id`, in-flight only)
-- planned as a Nested Loop Anti Join with a Seq Scan of the requests table on the INNER side — the
-- outer estimate was 1 row, the actual 13,884 candidates — so every tick scanned the requests table
-- 13,884 times (EXPLAIN 2026-09-07 05:50Z: 2,548 ms, shared hit 306,575). The requests table grows
-- ~7K rows/day (it is the lane's audit record and is never pruned), so the cost was compounding.
--
-- Fix: the in-flight set (rows with `drained_at IS NULL` in the last 10 min — 10–16 rows) is read
-- ONCE into a MATERIALIZED CTE and anti-joined; same candidates, same ordering, same `p_max`.
-- Measured: 116 ms / 1,493 buffers (22× faster, 205× fewer buffers). The listing dispatcher's
-- equivalent clause already planned with a Materialize node (11 ms) and is left alone.
-- Also: a partial index for the in-flight scan itself, so it stays O(in-flight) as the table grows.
--
-- REVERT: re-apply the function body from 20260907024130 (the NOT EXISTS form);
--         DROP INDEX public.idx_tamr_inflight;

CREATE INDEX IF NOT EXISTS idx_tamr_inflight
  ON public.topshot_atlas_market_requests (dispatched_at)
  WHERE drained_at IS NULL;

CREATE OR REPLACE FUNCTION public.atlas_edition_verify_dispatch(p_max int DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r record; v_req bigint; v_n int := 0;
BEGIN
  FOR r IN
    WITH inflight AS MATERIALIZED (
      -- the probes dispatched in the last 10 min and not yet drained: 10–16 rows, read once
      SELECT q.error
        FROM public.topshot_atlas_market_requests q
       WHERE q.drained_at IS NULL AND q.dispatched_at > now() - interval '10 minutes'
    ), cand AS (
      -- editions with an edition_offers row (the readers' surface) …
      SELECT m.atlas_edition_id, eo.updated_at AS stale_at
        FROM public.edition_offers eo
        JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
       WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      UNION ALL
      -- … and editions carrying an open offer or listing in our events
      SELECT ev.atlas_edition_id, min(ev.last_seen_at)
        FROM public.topshot_atlas_market_events ev
       WHERE ev.product = 'nba' AND NOT ev.completed AND ev.atlas_edition_id IS NOT NULL
       GROUP BY ev.atlas_edition_id
    )
    SELECT c.atlas_edition_id, min(c.stale_at) AS stale_at
      FROM cand c
      LEFT JOIN public.topshot_atlas_edition_verified v ON v.atlas_edition_id = c.atlas_edition_id
      LEFT JOIN inflight i ON i.error = '__edition__' || c.atlas_edition_id
     WHERE c.atlas_edition_id IS NOT NULL
       AND (v.verified_at IS NULL OR v.verified_at < now() - interval '24 hours')
       AND i.error IS NULL
     GROUP BY c.atlas_edition_id, v.verified_at
     ORDER BY COALESCE(v.verified_at, '-infinity'::timestamptz) ASC, min(c.stale_at) ASC NULLS FIRST
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', 'nba', 'editionId', r.atlas_edition_id, 'limit', 200),
      headers := public.atlas_market_headers('nba'),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
    VALUES (v_req, 'nba', -4, '__edition__' || r.atlas_edition_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;
-- anon-exec: intentional — same signature as 20260907024130, ACLs preserved (atlas_edition_verify_dispatch)
