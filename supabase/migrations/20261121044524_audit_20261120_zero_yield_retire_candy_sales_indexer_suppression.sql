-- audit_20261120_zero_yield_retire_candy_sales_indexer_suppression
--
-- The pipeline_zero_yield_suppressions row for candy-sales-indexer (added 10-30, re-dated 11-08) said to remove it
-- when Candy traded again or secondary_status left silent_since_*. 20261120144221 set thin_since_2026_11_19 and the
-- indexer wrote rows on 11-19 / 11-20. From now on a zero from this lane is a stall the Zero-Yield arm must see.
-- Filed by Claude Code 2026-11-20 (inbox 2026-11-21T0315Z; MCP held the DELETE); applied by Cowork in the Supabase
-- SQL editor 2026-11-20 ~8:46 PM PT (Trevor: "Proceed").
--
-- REVERT: re-insert the row (text in the 10-30 / 11-08 migrations) if Candy goes silent again.

DO $mig$
DECLARE v_status text;
BEGIN
  SELECT secondary_status INTO v_status FROM public.v_collection_marketplace_status WHERE slug = 'candy_mlb';
  IF v_status IS NULL OR v_status LIKE 'silent_since%' THEN
    RAISE EXCEPTION 'premise false: candy_mlb secondary_status is % — the suppression still applies', v_status;
  END IF;
END
$mig$;

DELETE FROM public.pipeline_zero_yield_suppressions WHERE pipeline = 'candy-sales-indexer';
