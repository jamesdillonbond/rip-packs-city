-- audit_20260907: index the OPEN events by edition for the verify lane's per-edition subqueries.
-- sync_edition_offers_from_atlas() (b)/(a) run one correlated lookup per edition verified in the
-- last 24 h (up to ~1,440/day at the lane's cadence); the existing partial index covers listings
-- only. First tick with 2 verified editions: 1,987 ms. The table is ~3K rows today and grows with
-- the market, so a plain (non-concurrent) build is instant now and the index is what keeps the
-- tick flat as the verified set fills. REVERT: DROP INDEX public.idx_tame_open_by_edition_any_kind;
CREATE INDEX IF NOT EXISTS idx_tame_open_by_edition_any_kind
  ON public.topshot_atlas_market_events (product, atlas_edition_id, kind, last_seen_at)
  WHERE NOT completed;
