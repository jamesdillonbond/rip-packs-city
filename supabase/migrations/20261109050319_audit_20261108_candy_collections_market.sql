-- audit_20261108_candy_collections_market
--
-- Market tracking for every catalogued non-registry Candy collection (Trevor 2026-11-08: "we
-- need to track and measure all of this"; scope: all MLB + non-MLB, no tests). The rotating
-- census (20261108222220) records WHO HOLDS each of the ~398 collections; nothing recorded
-- their MARKET. Measured: each trades under its own Magic Eden symbol (2022 Leadoff ICONs =
-- `2022_leadoff_icons`, read from ME's own /tokens/<mint> record), with thin volume (1 sale in
-- 3 days on the largest) and real listings (2022 Play of the Day: 94 listed).
--
-- candy_collections gains the symbol, its check stamp, and the market lane's own cursor
-- (sales_high_water_at: the newest feed activity a COMPLETE walk covered) and state. New
-- candy_collection_market_daily keeps one ME /stats snapshot per collection per UTC day.
-- ⚠ ME /stats answers {"listedCount":0} with NO floorPrice for a symbol that does not exist
-- (probed with a bogus symbol), so stats_has_floor records whether the answer carried a floor:
-- listed_count = 0 without one is "no listings OR unknown", never a confirmed empty market.
--
-- RLS on, no policies: service_role only (the lane and the admin reads).
--
-- Rollback: DROP TABLE public.candy_collection_market_daily;
--   ALTER TABLE public.candy_collections DROP COLUMN me_symbol, DROP COLUMN me_symbol_checked_at,
--     DROP COLUMN market_checked_at, DROP COLUMN market_error, DROP COLUMN sales_high_water_at;

ALTER TABLE public.candy_collections
  ADD COLUMN IF NOT EXISTS me_symbol text,
  ADD COLUMN IF NOT EXISTS me_symbol_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS market_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS market_error text,
  ADD COLUMN IF NOT EXISTS sales_high_water_at timestamptz;

COMMENT ON COLUMN public.candy_collections.sales_high_water_at IS
  'Newest Magic Eden activity time a COMPLETE /api/ingest/candy-collections-market walk covered for this collection; sales newer than it are offered to candy_sales_unresolved for the sales indexer drain. NULL = never walked (first walk looks back 30 days).';

CREATE TABLE IF NOT EXISTS public.candy_collection_market_daily (
  address text NOT NULL REFERENCES public.candy_collections(address) ON DELETE CASCADE,
  day date NOT NULL,
  me_symbol text NOT NULL,
  floor_sol numeric,
  listed_count integer,
  avg_price_24h_sol numeric,
  volume_all_sol numeric,
  stats_has_floor boolean NOT NULL,
  sol_usd numeric,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address, day)
);
ALTER TABLE public.candy_collection_market_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.candy_collection_market_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.candy_collection_market_daily TO service_role;
COMMENT ON TABLE public.candy_collection_market_daily IS
  'One Magic Eden /stats snapshot per non-registry Candy collection per UTC day (/api/ingest/candy-collections-market). stats_has_floor=false means ME returned no floorPrice: listed_count 0 is then not a confirmed empty market.';
