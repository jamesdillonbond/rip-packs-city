-- Bug 6 (perf, supporting): covering index so the "latest FMV per edition"
-- DISTINCT ON over the ~434k-row TS 2026 fmv_snapshots partition can apply its
-- fmv_usd filter/output index-only instead of ~408k heap fetches. Feeds the
-- mv_topshot_set_play_catalog refresh + any other latest-FMV-per-edition reader.
-- Applied in prod via CREATE INDEX CONCURRENTLY (outside a txn); written here as
-- plain CREATE INDEX IF NOT EXISTS for clean archival replay.
CREATE INDEX IF NOT EXISTS fmv_snapshots_2026_coll_ed_ct_fmv_idx
  ON public.fmv_snapshots_2026 (collection_id, edition_id, computed_at DESC)
  INCLUDE (fmv_usd);
