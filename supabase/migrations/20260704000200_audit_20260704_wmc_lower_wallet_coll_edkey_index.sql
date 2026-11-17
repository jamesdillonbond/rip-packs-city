-- Bug 6 (perf, supporting): covering index for the wallet's `owned` lookup in the
-- set RPCs — lower(wallet_address)=X AND collection_id=Y, returning edition_key.
-- Cuts the cold wmc heap scan (Trevor: ~20k moments) that dominated the rewritten
-- get_topshot_set_progress. Applied in prod as a non-concurrent build inside a
-- raised-statement_timeout session (wmc is 1.94M rows / 709 MB, beyond the MCP 2min
-- CONCURRENTLY window); written here as plain CREATE INDEX IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_wmc_lower_wallet_coll_edkey
  ON public.wallet_moments_cache (lower(wallet_address), collection_id)
  INCLUDE (edition_key);
