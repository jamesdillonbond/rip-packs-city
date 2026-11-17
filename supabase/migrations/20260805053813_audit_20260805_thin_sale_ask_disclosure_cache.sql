-- 2026-08-05 · Unblock the UI half of the thin-sale ASK disclosure.
--
-- PROBLEM (measured by Claude Code, and consistent with the 08-05 sales-partition
-- finding): v_fmv_thin_sale_ask_disclosure costs 28.8s / 1.26M buffers. Its `latest`
-- CTE is a DISTINCT ON over the whole fmv_snapshots table and `s90` aggregates every
-- sale in a 90-day window, so BOTH evaluate before any edition filter -- a per-edition
-- WHERE cannot push down. A page wired directly to this view would be a slow public
-- surface. (Independently: a bare `SELECT count(*) FROM sales WHERE sold_at >= now() -
-- 90 days` also exceeds 60s, because no sales partition carries an UNCONDITIONAL
-- sold_at-leading index -- every one of the twelve is partial. Same root cause as the
-- stale-fmv-monitor 504.)
--
-- FIX: a small cache table, refreshed on a schedule, that the page reads by edition_id.
-- The population is ~234 rows and moves slowly (a 90-day window), so live computation
-- buys nothing a page can perceive.
--
-- ⚠ SINGLE DEFINITION PRESERVED. The refresher does `SELECT * FROM
-- public.v_fmv_thin_sale_ask_disclosure` -- THE VIEW ITSELF, never a copy of its
-- predicate. This is the same discipline already used for fmv_sanity_flags in
-- rpc_trust_health_precompute_refresh, and it is the whole point of how Claude Code
-- defined the view (the clamp's own predicate with one term swapped, so the disclosure
-- cannot drift from the clamp it describes). A hand-written per-edition fast path was
-- the obvious alternative and was REJECTED for exactly this reason: it would have
-- reintroduced the drift the view exists to prevent.
--
-- FAIL-LOUD: refreshed_at is per row and the refresh is transactional (DELETE + INSERT
-- in one statement pair inside the function). A dead refresher shows as an ageing
-- refreshed_at rather than as silently missing editions. Consumers MUST check it --
-- see the freshness helper below.
--
-- SECURITY: matches the view exactly -- service_role only, anon and authenticated
-- revoked. The disclosure renders server-side.
--
-- REVERT:
--   DROP FUNCTION public.fmv_thin_sale_ask_disclosure_refresh();
--   DROP TABLE public.fmv_thin_sale_ask_disclosure_cache;
--   (and unschedule the cron job)

CREATE TABLE IF NOT EXISTS public.fmv_thin_sale_ask_disclosure_cache AS
  SELECT *, now() AS refreshed_at
  FROM public.v_fmv_thin_sale_ask_disclosure
  WHERE false;

ALTER TABLE public.fmv_thin_sale_ask_disclosure_cache
  ALTER COLUMN refreshed_at SET NOT NULL,
  ALTER COLUMN refreshed_at SET DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS fmv_thin_sale_ask_disclosure_cache_pkey
  ON public.fmv_thin_sale_ask_disclosure_cache (edition_id);

ALTER TABLE public.fmv_thin_sale_ask_disclosure_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.fmv_thin_sale_ask_disclosure_cache FROM anon, authenticated;
GRANT SELECT ON public.fmv_thin_sale_ask_disclosure_cache TO service_role;

COMMENT ON TABLE public.fmv_thin_sale_ask_disclosure_cache IS
  'Materialised population for the thin-sale ASK disclosure (handoff 2026-08-04 section 3). Refreshed by fmv_thin_sale_ask_disclosure_refresh() from v_fmv_thin_sale_ask_disclosure -- THE VIEW ITSELF, never a copy of its predicate, so it cannot drift from the clamp the disclosure describes. Exists because the view costs 28.8s / 1.26M buffers: its DISTINCT ON over all fmv_snapshots and its 90-day sales aggregate both evaluate before any edition filter, so a per-edition WHERE cannot push down. ALWAYS check refreshed_at before rendering -- a dead refresher ages this table rather than emptying it.';

CREATE OR REPLACE FUNCTION public.fmv_thin_sale_ask_disclosure_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  t0 timestamptz := clock_timestamp();
  v_rows bigint;
BEGIN
  -- Single transaction: the table is never observed empty by a concurrent reader.
  DELETE FROM public.fmv_thin_sale_ask_disclosure_cache;

  INSERT INTO public.fmv_thin_sale_ask_disclosure_cache
  SELECT v.*, now()
  FROM public.v_fmv_thin_sale_ask_disclosure v;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- A zero-row result is REAL (the clamp could legitimately drain the cohort), but it
  -- is also what a broken upstream looks like, so it is reported rather than silent.
  RETURN jsonb_build_object(
    'rows', v_rows,
    'duration_ms', round(EXTRACT(epoch FROM clock_timestamp() - t0) * 1000),
    'refreshed_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fmv_thin_sale_ask_disclosure_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_thin_sale_ask_disclosure_refresh() TO service_role;

COMMENT ON FUNCTION public.fmv_thin_sale_ask_disclosure_refresh() IS
  'Repopulates fmv_thin_sale_ask_disclosure_cache from v_fmv_thin_sale_ask_disclosure. Reads THE VIEW, never a copy of its predicate. ~30s. Runs on cron; do NOT call it from an MCP client -- the 60s client timeout rolls it back.';
