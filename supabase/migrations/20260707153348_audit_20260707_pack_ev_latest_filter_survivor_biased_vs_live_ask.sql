-- Read-layer honesty guard: pack_ev_latest never surfaces a Top Shot EV that balloons past
-- the live secondary ask (>3x). A depleted/chase-only remaining pool produces a fabricated
-- EV no pool-shape guard can catch; the only reliable signal is EV vs the live ask. Filtered
-- at the single read surface -> survivor-biased EV never reaches pack_table_rows / pages /
-- board / api, regardless of which writer produced it (active edge fn OR backfill). No more
-- purge whack-a-mole against the continuous edge fn. Mirrors Fix B (display) + jobid-43 guard.
-- Uses the LIVE ask (pack_ask_state, indexed); row-level secondary_ask is mostly null. TS-only;
-- sentinels + no-live-ask rows unaffected. Applied live via MCP (20260707153348). Grants/security
-- unchanged (reloptions null; REPLACE preserves anon SELECT). Revert: drop the AND NOT(...) clause.
CREATE OR REPLACE VIEW public.pack_ev_latest AS
 SELECT DISTINCT ON (pack_listing_id) pack_listing_id,
    collection_id, dist_id, pack_name, pack_price, gross_ev, pack_ev, is_positive_ev,
    value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct,
    snapshotted_at, primary_price, secondary_ask, price_source, primary_available,
    secondary_available
   FROM pack_ev_history
  WHERE pack_ev >= ('-10000'::integer)::numeric
    AND pack_ev <= (1000000)::numeric
    AND pack_price > (0)::numeric
    AND pack_name !~~ 'Holding %'::text
    AND NOT (
      collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND EXISTS (
        SELECT 1 FROM pack_ask_state a
        WHERE a.collection_slug = 'nba-top-shot'
          AND a.dist_id = pack_ev_history.dist_id
          AND a.is_listed IS TRUE
          AND a.lowest_ask > (0)::numeric
          AND pack_ev_history.gross_ev > (3)::numeric * a.lowest_ask
      )
    )
  ORDER BY pack_listing_id, snapshotted_at DESC;
