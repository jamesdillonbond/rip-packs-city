-- audit_20261010_allday_market_editions_excludes_ghost_listings
--
-- 2026-10-10 (~2:05 AM PT, Claude Code cloud). get_allday_market_editions (the
-- All Day Market editions board) computed floor_ask and listed_count over every
-- cached_listings_v2 row with completed_at IS NULL. A listing closes only on its
-- OWN ListingCompleted event, so a moment sold through a different listing leaves
-- the original "open" forever — the ghost set allday_listings_sold_after_listing
-- names (refreshed every 15 min) and allday_edition_floor_ask already excludes.
-- MEASURED 10-10 2:00 AM PT over the default board (500 editions): floor_ask was
-- a ghost's price on 282 and listed_count included ghosts on 332. NO-CHANGE
-- CONTROL, same instrument: recomputing floor/count with the function's own
-- filters but WITHOUT the anti-join matched the function on 500/500 (0 and 0),
-- so every one of those differences is a ghost.
--
-- Change: the same anti-join the sniper got in 20261010085726, added after the
-- function's two identical open-listing filters (asserted to occur exactly
-- twice). Spliced into pg_get_functiondef in a guarded DO block, the form the
-- previous two edits of this function used (20260923234631, 20260926141315).
-- Cost at default arguments: 48,382 → 49,711 shared buffers (+2.7 %), 148 → 148 ms.
-- Verified after apply: floor_ask and listed_count match the ghost-free
-- recomputation on 500/500 editions (0 and 0 differences).
--
-- anon-exec: unchanged (get_allday_market_editions) — body-only CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false verified 2026-10-10.
--
-- REVERT: re-run this splice inverted (remove the NOT EXISTS block from both
-- open-listing filters).

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
BEGIN
  SELECT pg_get_functiondef('public.get_allday_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric)'::regprocedure)
    INTO def;

  anc := E'        AND cl.completed_at IS NULL\n        AND cl.source <> ''flowty''\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 2 THEN RAISE EXCEPTION 'allday market open-listing anchor found % times, want 2', n; END IF;
  IF position('allday_listings_sold_after_listing' in def) > 0 THEN
    RAISE EXCEPTION 'ghost anti-join already present — refusing to splice twice';
  END IF;
  def := replace(def, anc, anc
    || E'        AND NOT EXISTS (\n'
    || E'          SELECT 1 FROM allday_listings_sold_after_listing g\n'
    || E'          WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source\n'
    || E'        )\n');

  EXECUTE def;
END
$mig$;
