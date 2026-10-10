-- audit_20261010_edition_verify_incomplete_wait_exceeds_the_rotation
-- anon-exec: unchanged (atlas_edition_verify_dispatch) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=false 2026-10-10.
--
-- 2026-10-10 (known-issues #85), follow-up to 20261010181714 minutes later. That migration made an
-- edition whose last snapshot was incomplete wait 7 days instead of 24 h. Re-derived after apply:
-- the rotation's cycle is ~11 days (14,052 editions / ~1,236 calls a day), so a 7-day wait is
-- shorter than the time every edition already waits and changes nothing in steady state (9,921
-- incomplete / 7 days = 1,417 eligible a day, which alone exceeds capacity). The wait has to EXCEED
-- the cycle: at 30 days the incomplete editions take ~331 calls a day and the ~4,131 that can
-- conclude cycle every ~4.6 days instead of ~11. Pin claim 2 re-pointed (a 20-day-old incomplete
-- verify still waits; a 31-day-old one is eligible).
--
-- REVERT: re-apply atlas_edition_verify_dispatch from 20261010181714 (7 days) or 20260907055104 (none).

CREATE OR REPLACE FUNCTION public.atlas_edition_verify_dispatch(p_max integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
       -- 2026-10-10 (#85): an edition whose last snapshot was INCOMPLETE (Atlas totalCount
       -- capped at 201 = more than one 200-row page) can never conclude -- its history only
       -- grows -- and its newest events already reach us through the firehose. It waits 30 days
       -- instead of 24 h, so the calls go to editions that CAN close their stale listings.
       -- ⚠ The wait must EXCEED the rotation's cycle (~11 days at ~1,236 calls/day over 14,052
       -- editions) or it changes nothing: 7 days was tried first and is a no-op in steady state.
       AND NOT (v.complete IS FALSE AND v.verified_at > now() - interval '30 days')
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
END $function$;
