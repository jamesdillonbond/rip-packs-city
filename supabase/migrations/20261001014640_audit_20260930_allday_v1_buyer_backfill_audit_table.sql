-- audit_20260930_allday_v1_buyer_backfill_audit_table
--
-- Records every buyer_address that scripts/allday-v1-buyer-backfill.mjs writes onto All Day V1
-- rows (sales + unmapped_sales) whose buyer was NULL. The script inserts here BEFORE it updates,
-- and only updates rows still NULL, so this table is an exact revert list (register #161: buybacks
-- count as market sales AND are tracked, which needs the buyer).
--
-- Service-role only: RLS on, no policies, no anon/authenticated grants.
--
-- REVERT of the data (per table):
--   UPDATE public.sales s SET buyer_address = NULL FROM public.audit_20260930_allday_v1_buyer_backfill a
--    WHERE a.tbl = 'sales' AND s.id = a.row_id AND s.buyer_address = a.buyer;
--   UPDATE public.unmapped_sales u SET buyer_address = NULL FROM public.audit_20260930_allday_v1_buyer_backfill a
--    WHERE a.tbl = 'unmapped_sales' AND u.id = a.row_id AND u.buyer_address = a.buyer;
-- REVERT of this object: DROP TABLE public.audit_20260930_allday_v1_buyer_backfill;

CREATE TABLE IF NOT EXISTS public.audit_20260930_allday_v1_buyer_backfill (
  tbl text NOT NULL CHECK (tbl IN ('sales', 'unmapped_sales')),
  row_id uuid NOT NULL,
  buyer text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tbl, row_id)
);

ALTER TABLE public.audit_20260930_allday_v1_buyer_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260930_allday_v1_buyer_backfill FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.audit_20260930_allday_v1_buyer_backfill TO service_role;
