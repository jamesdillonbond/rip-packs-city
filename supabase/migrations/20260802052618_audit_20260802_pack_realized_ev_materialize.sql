-- audit_20260802_pack_realized_ev_materialize
-- Applied to prod 2026-08-02 05:26 UTC / 2026-08-01 22:26 PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- SUPERSEDED IN THE SAME SESSION by
-- 20260802052711_audit_20260802_pack_realized_ev_materialize_v2_swap_view.sql,
-- which DROPs this matview and rebuilds it from the view's verbatim body. Kept
-- for history and because it is what prod actually recorded.
--
-- WHY THIS FORM DOES NOT WORK: defining the matview as
-- `SELECT * FROM public.v_topshot_pack_realized_ev` cannot then be swapped onto
-- -- repointing the view at the matview would make the view depend on a matview
-- that depends on the view. The matview must own the full body, which is the
-- pattern the three sibling board MVs used. See the v2 migration.
--
-- WHY the leg needed materializing at all (and the mis-measurement that hid it)
-- is documented in full in the v2 header.
--
-- REVERT: DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_realized_ev;

SET LOCAL statement_timeout = '600s';

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_topshot_pack_realized_ev AS
SELECT * FROM public.v_topshot_pack_realized_ev;

CREATE UNIQUE INDEX IF NOT EXISTS mv_topshot_pack_realized_ev_dist_key
  ON public.mv_topshot_pack_realized_ev (dist_id);

GRANT SELECT ON public.mv_topshot_pack_realized_ev TO anon, authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.mv_topshot_pack_realized_ev IS
  'Backing store for public.v_topshot_pack_realized_ev. Refreshed hourly by pg_cron rpc-refresh-pack-realized-ev (600s inner budget). Read through the VIEW, never directly. Grants intentionally mirror the view (anon SELECT) because v_topshot_pack_ev_calibrated is an anon-readable security_invoker view that reads it.';
