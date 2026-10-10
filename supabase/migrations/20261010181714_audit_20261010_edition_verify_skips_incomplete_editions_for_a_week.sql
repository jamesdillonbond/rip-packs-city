-- audit_20261010_edition_verify_skips_incomplete_editions_for_a_week
-- anon-exec: unchanged (atlas_edition_verify_dispatch) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
--
-- 2026-10-10 (known-issues #85). The edition lane re-fetches each Top Shot edition's Atlas
-- snapshot ({editionId, limit:200}) once its last verify is > 24 h old, oldest first, and
-- atlas_edition_verify_settle closes stale open listings only from a COMPLETE snapshot (totalCount
-- <= 200). Measured today: 14,052 editions in the rotation (~1,236 verified/day, ~11-day cycle);
-- 9,921 (71 %) last came back INCOMPLETE -- totalCount pinned at Atlas's 201 cap -- and in the last
-- 24 h 685 of 1,236 calls (55 %) did. An edition's history only grows, so those can never conclude,
-- and their newest events already reach us through the platform firehose. Each such call is spent
-- where nothing can close.
--
-- WHAT. One predicate: an edition whose last snapshot was incomplete is skipped until that verify
-- is 7 days old (was 24 h). Ordering, scope and request shape are unchanged. The ~4,100 editions
-- that CAN conclude get the freed calls, so their stale listings close several times sooner.
-- Base = live definition read immediately before (md5 25d89a4d4575d56ee1feb8be58a21bda). New pin
-- supabase/tests/atlas_edition_verify_dispatch.sql (the old body reds claim 2).
--
-- REVERT: re-apply atlas_edition_verify_dispatch from 20260907055104.

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
       -- grows -- and its newest events already reach us through the firehose. It waits 7 days
       -- instead of 24 h, so the calls go to editions that CAN close their stale listings.
       AND NOT (v.complete IS FALSE AND v.verified_at > now() - interval '7 days')
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
