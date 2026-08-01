-- audit_20260801_pinnacle_sales_render_rollup_covering_index
--
-- Applied to prod 2026-08-01 via Supabase MCP apply_migration; this file is the
-- repo record of that change (identical SQL, idempotent -- re-applying is a no-op).
--
-- WHY. v_rpc_trust_health ran ~8s warm and could exceed the 30s service_role
-- statement budget cold, which makes the whole 25-arm trust board go UNREAD.
-- (It does NOT go falsely green: v_rpc_trust_health's consumer is /api/sentinel,
-- which classifies the error via isSaturationError() and reports status:"warn"
-- prefixed "INCONCLUSIVE (db saturated) — ". get_pipeline_alerts() -- the
-- /api/check-alerts path -- does not read this view at all.)
--
-- The dominant leg was the pinnacle_fmv_impossible_flags arm
-- (v_pinnacle_fmv_sanity_flags): a per-render 90d rollup over pinnacle_sales that
-- planned as a Bitmap Heap Scan touching 3,831 blocks (3,661 heap) per call and
-- returned shared hit=6 read=3825 -- essentially zero cache hits, i.e. it
-- re-read ~30MB from disk EVERY call on the Micro instance. Measured 3,911-4,639ms,
-- ~50-58% of total view runtime.
--
-- The existing idx_pinnacle_sales_pulse_window already covers
-- (sold_at DESC) INCLUDE (sale_price_usd, buyer_address, seller_address) but omits
-- render_id, so the rollup could not go index-only.
--
-- MEASURED EFFECT (2026-08-01): the arm plans as an Index Only Scan and runs
-- 3,911ms -> 30.6-35ms; disk reads on that leg 3,742 -> 240 (the cache-independent
-- metric, so the cold path improves by ~3,500 block reads). Whole view 7,999ms ->
-- 1,006ms. Board unchanged: 25 arms, 0 breaching, pinnacle_fmv_impossible_flags
-- still 0. Index is ~9MB.
--
-- WHY INDEX-ONLY ACTUALLY ENGAGES HERE (this is the load-bearing precondition):
-- pinnacle_sales was 100% all-visible at apply time (relallvisible = relpages =
-- 6474). The documented counter-case -- a covering INCLUDE index NOT helping
-- because the wanted rows sit on hot, not-all-visible pages -- does not apply to
-- this table's append + autovacuum pattern. Residual Heap Fetches (~9k) come from
-- rows written since the last autovacuum and are cache hits, not disk reads.
--
-- DURABLE NOTE. A 2026-08-01 handoff proposed instead moving the `packev` CTE into
-- rpc_trust_health_precompute, citing "packev is 92% of it". packev is 92% of the
-- planner COST ESTIMATE (522,256 of 567,668) but only ~8.5% of RUNTIME (676ms of
-- 7,999ms). Cost is not time. That change would have bought ~8% for up to 6h of
-- staleness on two arms. Do not act on the cost figure.
--
-- REVERT: DROP INDEX IF EXISTS public.idx_pinnacle_sales_render_rollup;
--         (pure performance object -- no behavioural or value change to any arm.)

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_pinnacle_sales_render_rollup
  ON public.pinnacle_sales USING btree (sold_at DESC)
  INCLUDE (render_id, sale_price_usd);

COMMENT ON INDEX public.idx_pinnacle_sales_render_rollup IS
  'Covering index for the 90d per-render sales rollup behind v_pinnacle_fmv_sanity_flags (the pinnacle_fmv_impossible_flags arm of v_rpc_trust_health). Before: Bitmap Heap Scan over pinnacle_sales_sold_at_idx touching 3,831 blocks (3,661 heap) per call, ~4.3s, essentially zero cache hits on Micro -> the whole trust view ran ~8s warm and could exceed the 30s service_role budget cold, making the 25-arm board go UNREAD (sentinel correctly reports INCONCLUSIVE rather than ok, so this was a visibility gap, not a false-green). INCLUDE carries render_id + sale_price_usd so the rollup is index-only; pinnacle_sales was 100% all-visible (relallvisible=relpages=6474) when this was added, which is what makes index-only actually engage. NOTE 2026-08-01: the packev CTE is 92% of the view PLANNER COST but only ~8.5% of RUNTIME (676ms of 7,999ms) -- cost is not time; this arm was ~50-58%.';
