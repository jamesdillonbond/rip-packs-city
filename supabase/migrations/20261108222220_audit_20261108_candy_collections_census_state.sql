-- audit_20261108_candy_collections_census_state
--
-- State for the rotating census of every catalogued, non-test Candy collection outside the
-- five registry sets (app/api/ingest/candy-collections-census, hourly). 396 collections,
-- ~1.37M items, ~1,400 DAS pages — too many for one daily lambda, so each run walks pages
-- inside a time budget and keeps its place here; a collection's walk can span runs
-- (2022 Leadoff ICONs alone is ~380 pages).
--   census_page            next getAssetsByGroup page to read (1 = not started / restart)
--   census_walk_started_at when the current walk began (NULL when no walk is in flight)
--   last_census_at         when a walk last COMPLETED (a short page was read)
--   last_census_items      cards (non-pack, non-burnt) that walk saw
--   last_census_error      the last page error, cleared by the next successful page
--
-- anon-exec: intentional — no functions created or replaced here
--
-- Rollback: ALTER TABLE candy_collections DROP COLUMN census_page, DROP COLUMN census_walk_started_at,
--   DROP COLUMN last_census_at, DROP COLUMN last_census_items, DROP COLUMN last_census_error;

ALTER TABLE public.candy_collections
  ADD COLUMN census_page integer NOT NULL DEFAULT 1 CHECK (census_page >= 1),
  ADD COLUMN census_walk_started_at timestamptz,
  ADD COLUMN last_census_at timestamptz,
  ADD COLUMN last_census_items integer,
  ADD COLUMN last_census_error text;
