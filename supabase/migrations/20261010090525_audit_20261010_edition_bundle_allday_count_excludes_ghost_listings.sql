-- audit_20261010_edition_bundle_allday_count_excludes_ghost_listings
--
-- 2026-10-10 (~2:05 AM PT, Claude Code cloud). get_edition_market_bundle's
-- `active_listings` (the edition page's "N listed") counted every All Day
-- cached_listings_v2 row with completed_at IS NULL — including GHOSTS, listings
-- whose moment sold through a different listing and that never get their own
-- ListingCompleted (allday_listings_sold_after_listing names them; same class
-- as 20261010085726 / 20261010085932). MEASURED 10-10: 1,464 All Day editions
-- carried an inflated count, 25 of them showing listings where every listing
-- was a ghost (edition 888: 43 listed, 20 ghosts).
--
-- Change: the ghost anti-join, scoped to All Day rows only (the ghost set is
-- All Day's; Golazos rows pass untouched), spliced into pg_get_functiondef in a
-- guarded DO block (anchor asserted once; refuses a double splice).
-- Verified after apply: edition 888 → 23; a Golazos edition unchanged (15 vs a
-- direct count of 15); has_function_privilege anon=false.
--
-- anon-exec: unchanged (get_edition_market_bundle) — body-only CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- REVERT: re-run the splice inverted (remove the `AND (cl.collection_id <> … OR
-- NOT EXISTS (…))` line block).

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
BEGIN
  SELECT pg_get_functiondef('public.get_edition_market_bundle(uuid, text)'::regprocedure) INTO def;
  IF position('allday_listings_sold_after_listing' in def) > 0 THEN
    RAISE EXCEPTION 'ghost anti-join already present — refusing to splice twice';
  END IF;
  anc := E'              AND (cl.expiry_at IS NULL OR cl.expiry_at > now())\n          ) ELSE NULL END';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'edition bundle active-count anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
       E'              AND (cl.expiry_at IS NULL OR cl.expiry_at > now())\n'
    || E'              AND (cl.collection_id <> ''dee28451-5d62-409e-a1ad-a83f763ac070''::uuid OR NOT EXISTS (\n'
    || E'                SELECT 1 FROM allday_listings_sold_after_listing g\n'
    || E'                WHERE g.listing_resource_id = cl.listing_resource_id AND g.source = cl.source))\n'
    || E'          ) ELSE NULL END');
  EXECUTE def;
END
$mig$;
