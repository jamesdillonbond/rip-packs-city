-- PUBLIC-BOARD-CACHING (nc1, 2026-08-09): a throttle-immune default-payload cache
-- for the hottest public /insights board API routes. One row per board_key holding
-- the JSON body of the DEFAULT (unfiltered) request. The heavy backing views are
-- read only on the live/warm path; the request fast-path reads a single tiny PK row
-- here (cache-resident, immune to the disk-IO-budget throttling that 500s/times-out
-- the full board views). Written on the live path (self-warm) and by the
-- /api/cron/refresh-insights-cache cron. service_role only — never anon-readable.
--
-- Applied to prod via MCP as audit_20260809_public_board_snapshots_cache; this file
-- is committed for repo↔DB parity (re-running is a no-op via IF NOT EXISTS).
-- Revert: DROP TABLE public.public_board_snapshots;
CREATE TABLE IF NOT EXISTS public.public_board_snapshots (
  board_key    text PRIMARY KEY,
  payload      jsonb NOT NULL,
  row_count    integer,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.public_board_snapshots IS
  'Precomputed default-payload cache for the hottest public /insights board API routes (nc1 PUBLIC-BOARD-CACHING, 2026-08-09). One row per board_key = the JSON body of the default (unfiltered) request; read by the routes as a throttle-immune fast path with stale-serve-on-error fallback, written on the live path and by /api/cron/refresh-insights-cache. service_role only.';

-- RLS on (keeps the "0 tables with rowsecurity=false" invariant); no policy, so
-- anon/authenticated get nothing and service_role bypasses RLS.
ALTER TABLE public.public_board_snapshots ENABLE ROW LEVEL SECURITY;

-- Strip Supabase's default per-role grants explicitly (REVOKE FROM PUBLIC alone
-- does NOT remove the anon/authenticated default grants — verified footgun).
REVOKE ALL ON public.public_board_snapshots FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_board_snapshots TO service_role;
