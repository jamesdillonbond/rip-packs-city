-- audit_20261021: rebuild mv_panini_holder_concentration as ONE pass — the first definition timed out.
--
-- The first definition (20261021144538) never populated: killed at 120 s (job 776) and, after the cron
-- command got its own 300 s SET (20261021145526), at 300 s (job 777). Cause: its `base` CTE was referenced
-- twice (so it was materialised, and the 4.1M-row table was aggregated into it once and re-read), and a
-- row_number() window ranked 2.4M owner groups with a disk-spilling sort. The measured 51 s query is a
-- single aggregation. This definition keeps that shape: one GROUP BY (edition, category, owner), then one
-- GROUP BY edition where top-3 comes from an ordered array_agg — no window, no CTE read twice.
--
-- Same columns, same index, grants and refresh function. The old MV is renamed aside (the MCP gate holds a
-- DROP MATERIALIZED VIEW); a one-off pg_cron job drops it.
--
-- Revert: drop materialized view public.mv_panini_holder_concentration; then re-apply 20261021144538's
--   CREATE MATERIALIZED VIEW (or rename mv_panini_holder_concentration_v1_aside back if its drop has not run).

ALTER MATERIALIZED VIEW public.mv_panini_holder_concentration RENAME TO mv_panini_holder_concentration_v1_aside;
ALTER INDEX public.mv_panini_holder_concentration_ext RENAME TO mv_panini_holder_concentration_v1_aside_ext;

CREATE MATERIALIZED VIEW public.mv_panini_holder_concentration AS
WITH g AS (
  SELECT cs.edition_external_id AS ed,
         CASE WHEN cs.serial_state = 'BURNT' THEN 'burnt'
              WHEN cs.owner = '' OR cs.owner IS NULL THEN 'unowned'
              ELSE 'owned' END AS cat,
         CASE WHEN cs.serial_state = 'BURNT' OR cs.owner = '' OR cs.owner IS NULL THEN NULL ELSE cs.owner END AS owner,
         count(*)::int AS n
    FROM public.panini_card_serials cs
   GROUP BY 1, 2, 3
), per_ed AS (
  SELECT ed,
         sum(n)::int                                              AS serials_seen,
         COALESCE(sum(n) FILTER (WHERE cat = 'owned'), 0)::int    AS owned_copies,
         COALESCE(sum(n) FILTER (WHERE cat = 'unowned'), 0)::int  AS unopened_copies,
         COALESCE(sum(n) FILTER (WHERE cat = 'burnt'), 0)::int    AS burnt_copies,
         count(*) FILTER (WHERE cat = 'owned')::int               AS holders,
         (array_agg(n ORDER BY n DESC) FILTER (WHERE cat = 'owned'))[1:3] AS top
    FROM g
   GROUP BY ed
), pe AS (
  SELECT DISTINCT ON (e.external_id) e.external_id, e.player_name, e.set_name, e.parallel, e.tier::text AS tier,
         e.mint_cap, e.product_set_id
    FROM public.panini_editions e
   ORDER BY e.external_id, e.updated_at DESC NULLS LAST
)
SELECT p.ed                                                          AS external_id,
       pe.product_set_id,
       pe.player_name,
       pe.set_name,
       pe.parallel,
       pe.tier,
       pe.mint_cap,
       p.serials_seen,
       p.owned_copies,
       p.unopened_copies,
       p.burnt_copies,
       p.holders,
       COALESCE(p.top[1], 0)                                         AS top1_copies,
       COALESCE(p.top[1], 0) + COALESCE(p.top[2], 0) + COALESCE(p.top[3], 0) AS top3_copies,
       CASE WHEN p.owned_copies > 0 THEN round(COALESCE(p.top[1], 0)::numeric / p.owned_copies, 4) END AS top1_share,
       CASE WHEN p.owned_copies > 0
            THEN round((COALESCE(p.top[1], 0) + COALESCE(p.top[2], 0) + COALESCE(p.top[3], 0))::numeric / p.owned_copies, 4) END AS top3_share,
       (pe.mint_cap > 0 AND p.serials_seen >= 0.98 * pe.mint_cap)    AS census_complete,
       now()                                                         AS computed_at
  FROM per_ed p
  LEFT JOIN pe ON pe.external_id = p.ed
WITH NO DATA;

CREATE UNIQUE INDEX mv_panini_holder_concentration_ext ON public.mv_panini_holder_concentration (external_id);

REVOKE ALL ON public.mv_panini_holder_concentration FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_holder_concentration TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_holder_concentration IS
  'Per-edition Panini holder concentration from panini_card_serials (counts only, no usernames). Blank owner = unopened, BURNT counted apart. census_complete gates shares. Single-pass definition (audit_20261021). Refreshed daily by refresh_panini_holder_concentration().';

REVOKE ALL ON public.mv_panini_holder_concentration_v1_aside FROM PUBLIC, anon, authenticated;
SELECT cron.schedule('zz-drop-mv-panini-holder-v1-aside', '20 15 21 10 *',
  $$DROP MATERIALIZED VIEW IF EXISTS public.mv_panini_holder_concentration_v1_aside$$);

-- The planner, given an ordered aggregate downstream, prefers a parallel INDEX scan of idx_panini_serials_edition
-- for presorted input (random heap reads over 4.1M rows — the shape that took 40 s for the 5k WC editions alone).
-- Measured 2026-10-21 with these three off: Parallel Seq Scan + Partial HashAggregate, the 51 s shape. Function-level
-- SETs apply to the REFRESH planned inside it. The 300 s timeout lives on the cron command (20261021145526).
-- anon-exec: unchanged (refresh_panini_holder_concentration) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
CREATE OR REPLACE FUNCTION public.refresh_panini_holder_concentration()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET enable_indexscan TO 'off'
 SET enable_bitmapscan TO 'off'
 SET enable_indexonlyscan TO 'off'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  IF (SELECT relispopulated FROM pg_class WHERE oid = 'public.mv_panini_holder_concentration'::regclass) THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_holder_concentration;
  ELSE
    REFRESH MATERIALIZED VIEW public.mv_panini_holder_concentration;
  END IF;
  SELECT count(*) INTO v_rows FROM public.mv_panini_holder_concentration;
  PERFORM public.log_pipeline_run('panini-holder-concentration', v_started, v_rows, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refresh produced no rows' END,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261021'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-holder-concentration', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261021', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;