-- audit_20260919_pack_market_sales_cache
--
-- ── WHAT THIS FIXES (measured 2026-09-19) ─────────────────────────────────────
-- `get_pack_market_row()` aggregates a dist's ENTIRE sales history on every
-- pack-detail render. `EXPLAIN (ANALYZE, BUFFERS)` on dist_id 4184:
--
--   Aggregate (actual time=33643.561..33643.563)
--     Buffers: shared hit=11 read=8910 written=1657
--     -> Bitmap Heap Scan ... Heap Blocks: exact=8783, rows=16854
--
-- **8,910 buffers (71 MB) and 33.6 SECONDS for one page.** 16,854 rows scattered
-- across 8,783 heap pages is ~1.9 rows/page, so a single dist touches 41% of the
-- whole 21,521-page table.
--
-- 📏 The blast radius is a narrow tail, which is why a cache pays: of 1,849 Top
-- Shot dists, **4 hold >=10,000 rows, 15 hold 5k-10k, 51 hold 2k-5k - 70 dists
-- (3.8%) carrying 301,680 of 591,919 rows (51% of the table)**. The other 1,606
-- are under 500 rows and already fast.
--
-- ⛔ A COVERING INDEX IS NOT THE FIX HERE, AND THAT WAS MEASURED, NOT ASSUMED.
-- An index-only scan needs the visibility map, and `topshot_pack_sales_history`
-- cannot hold one: the backfill walker re-UPSERTS every row (`ON CONFLICT DO
-- UPDATE SET <every column>`, no change detection), so `relallvisible/relpages`
-- read **5.3% on 09-19**, and dead tuples went 25,512 -> 49,650 in ~40 minutes of
-- the walker running. An index-only scan would take a heap fetch for ~85% of
-- rows - MORE row-level fetches than the bitmap scan's 8,783 page reads. The VM
-- route is dead on this table until the writer gains change detection (R21).
--
-- ── WHY CACHE ONLY THE SALES AGGREGATE ────────────────────────────────────────
-- `get_pack_market_row` returns 11 columns. Nine come from the expensive history
-- aggregate; `retail_price` and `secondary_vs_retail_ratio` come from
-- `mv_pack_ev_latest`, which is **440 kB with an index on (dist_id,
-- collection_id)** - already cheap. Caching only the expensive half keeps the EV
-- side live, so the cache cannot serve a stale retail price.
--
-- ⚠ HONESTY: the reading function FALLS BACK TO THE LIVE AGGREGATE on a cache
-- miss, it does NOT return "no sales". `fetchPackMarket` treats a null row as
-- "no market data" and surfaces read failure separately as `ok: false`, so a
-- missing cache row that returned null would publish a false claim about a pack
-- that HAS sales. Fallback keeps the contract byte-identical.
--
-- ⚠ Consequence to keep in view: because the fallback exists, a dead refresh job
-- degrades SILENTLY back to 33-second renders. That is why the refresh writes a
-- `pipeline_runs` row every tick.
--
-- ── REVERT ────────────────────────────────────────────────────────────────────
--   SELECT cron.unschedule('rpc-pack-market-sales-cache-refresh');
--   -- restore get_pack_market_row from `20260919180751`'s REVERT note, then:
--   DROP FUNCTION public.refresh_pack_market_sales_cache(integer, integer);
--   DROP TABLE public.pack_market_sales_cache;
-- ⭐ Or, for an instant behavioural revert with no DDL at all:
--   TRUNCATE public.pack_market_sales_cache;
-- With an empty cache every call takes the live path and behaviour is identical.

CREATE TABLE IF NOT EXISTS public.pack_market_sales_cache (
  collection_id    uuid        NOT NULL,
  dist_id          text        NOT NULL,
  n_sales          bigint      NOT NULL,
  n_sales_30d      bigint      NOT NULL,
  n_sales_90d      bigint      NOT NULL,
  avg_price_90d    numeric,
  median_price_90d numeric,
  min_price_all    numeric,
  max_price_all    numeric,
  last_sale_price  numeric,
  last_sale_at     timestamptz,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, dist_id)
);

COMMENT ON TABLE public.pack_market_sales_cache IS
  'Precomputed per-dist sales aggregate for get_pack_market_row. Exists because '
  'the live aggregate read 8,910 buffers / 33.6 s for one pack page (dist 4184). '
  'Refreshed by refresh_pack_market_sales_cache(); READERS MUST FALL BACK to the '
  'live aggregate on a miss - a missing row means "not computed yet", never '
  '"no sales". See migration audit_20260919_pack_market_sales_cache.';

COMMENT ON COLUMN public.pack_market_sales_cache.computed_at IS
  'When this row was last recomputed. This is the cache''s OWN provenance - it is '
  'NOT the age of the underlying sales data, which is bounded separately by the '
  'pack-sales ingest lane (see unlatch_pack_sales_cursors).';

-- Anon needs nothing here: the only reader is a SECURITY DEFINER function.
ALTER TABLE public.pack_market_sales_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_market_sales_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pack_market_sales_cache TO postgres, service_role;
