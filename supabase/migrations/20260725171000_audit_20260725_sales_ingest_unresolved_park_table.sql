-- Applied live 2026-07-25 via MCP; committed for parity.
--
-- Step 1 of "we should have all historical sales": STOP DISCARDING.
--
-- apply_sales_ingest_external() counted its edition-unresolvable rows as
-- skipped_unresolved and threw them away -- ~85-90% of every Dune batch
-- (152,195 found -> 139,266 unresolved -> 1,074 inserted on a real run). Every
-- Dune datapoint spent on those rows was therefore spent AGAIN on any re-run.
--
-- Parking here rather than in public.unmapped_sales is deliberate. That table is
-- a shared work queue with consumers that do NOT filter by source:
--   * check_unmapped_backlog_growth() escalates to 'high' at open_rows >= 10000
--     with inflow > outflow -- one Dune run parks ~140k rows and would trip it
--     immediately and permanently;
--   * get_unmapped_resolver_targets() / resolve_unmapped_sales_for_collection()
--     would feed on-chain resolvers a backlog they cannot serve.
-- A dedicated table gets the same benefit with zero blast radius.
CREATE TABLE IF NOT EXISTS public.sales_ingest_unresolved (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id    uuid        NOT NULL,
  nft_id           text        NOT NULL,
  transaction_hash text        NOT NULL,
  price_usd        numeric     NOT NULL,
  sold_at          timestamptz NOT NULL,
  seller_address   text,
  buyer_address    text,
  parked_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_sale_id uuid,
  CONSTRAINT sales_ingest_unresolved_tx_nft_key UNIQUE (transaction_hash, nft_id)
);

CREATE INDEX IF NOT EXISTS sales_ingest_unresolved_open_idx
  ON public.sales_ingest_unresolved (collection_id, nft_id)
  WHERE resolved_at IS NULL;

ALTER TABLE public.sales_ingest_unresolved ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_ingest_unresolved FROM anon, authenticated;

COMMENT ON TABLE public.sales_ingest_unresolved IS
  'Dune sale rows that could not be edition-resolved at ingest. Parked (not discarded) so already-purchased Dune datapoints are never re-bought. RLS on, no policies: service_role only. Drained by resolve_sales_ingest_unresolved().';
