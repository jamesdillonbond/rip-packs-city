-- Unique key: (edition_id, mint_one_sold_at, transaction_hash) — 697/697 distinct, no NULLs.
-- ⚠ edition_id ALONE is NOT unique here (541 distinct over 697 rows) and neither is
-- (edition_id, transaction_hash) (629) — the board carries rows that are the SAME sale twice,
-- differing only in mint_one_sold_at, a duplicate-sales artifact upstream. The three-column
-- key is the most specific available and so the least likely to collide on a future refresh.
-- If it ever does, the refresh fails LOUDLY (cron.job_run_details) and the cadence watchlist
-- turns the resulting silence into an alarm — the behaviour we want from a canary.
CREATE UNIQUE INDEX mv_topshot_first_mint_trophies_key
  ON public.mv_topshot_first_mint_trophies (edition_id, mint_one_sold_at, transaction_hash);

REVOKE ALL ON public.mv_topshot_first_mint_trophies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_topshot_first_mint_trophies TO postgres, service_role;

-- ⚠ THE is_active GUARD IS REQUIRED HERE (it was not for panini). This board reads
-- `editions`, whose RLS policy is `collection_id IN (SELECT c.id FROM collections WHERE
-- c.is_active IS TRUE)`, and BOTH first-mint views are anon-SELECT true. A materialized view
-- is not RLS-governed, so without this a deactivated Top Shot would keep serving rows out of
-- the MV to anon until the next refresh.
--
-- All-or-nothing rather than per-row because this board is single-collection: verified two
-- ways — the view body hardcodes the Top Shot UUID, and every row joins back to exactly
-- 1 distinct collection_id. An EXISTS gate reproduces the RLS effect exactly.
CREATE OR REPLACE VIEW public.topshot_first_mint_trophies
WITH (security_invoker = on) AS
SELECT m.*
FROM public.mv_topshot_first_mint_trophies m
WHERE EXISTS (
  SELECT 1 FROM public.collections c
  WHERE c.slug = 'nba_top_shot' AND c.is_active IS TRUE
);
