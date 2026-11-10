CREATE INDEX IF NOT EXISTS idx_sales_2023_null_buyer_coll_sold ON public.sales_2023 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_sales_2024_null_buyer_coll_sold ON public.sales_2024 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_sales_2026_null_buyer_coll_sold ON public.sales_2026 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_sales_2027_null_buyer_coll_sold ON public.sales_2027 USING btree (collection, sold_at DESC) WHERE ((buyer_address IS NULL) AND (transaction_hash IS NOT NULL));
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_sales_2023_null_buyer_coll_sold','idx_sales_2024_null_buyer_coll_sold','idx_sales_2026_null_buyer_coll_sold','idx_sales_2027_null_buyer_coll_sold')
     AND i.indisvalid AND i.indisready;
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 valid sales null-buyer generic-plan indexes, found %', n;
  END IF;
END $$;