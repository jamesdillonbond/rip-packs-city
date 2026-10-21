-- audit_20261021: Panini holder concentration (ripz.one "Chokehold" parity), counts only.
--
-- ripz.one sells "which cards a few collectors have cornered" in its $25 All-Star tier. RPC already holds the
-- owner of every serial it has read (panini_card_serials.owner). This materialises per-edition concentration so a
-- "Holders" tab can show it free. It stores COUNTS ONLY — no username leaves this MV, matching the Panini boards'
-- rule that "nothing on these boards needs a person's handle" (lib/insights/panini-more-boards.ts).
--
-- Measured 2026-10-21 before writing (read-only):
--   · owner = '' on an AVAILABLE serial means UNOPENED: in 17,890 of 29,109 editions the blank count equals
--     panini_editions.still_in_packs exactly (20,479 <=). Blank owners are not holders; they are counted apart.
--   · serial_state = 'BURNT' rows keep an owner (207,265 rows) — counted apart, never as holdings.
--   · The top 15 owners by copies all trade actively (hundreds to thousands of buys/sells in panini_sales), so no
--     platform account sits in the census today. If one appears, exclude it through a registry, never a literal.
--   · One sequential pass over all products: 50.8 s, ~615k pages, 37,113 editions. Too heavy hourly; the board
--     moves slowly, so the refresh is DAILY (pg_cron rpc-panini-holder-concentration, 5:29 AM PT).
--   · Census: 32,239 of 37,006 editions have a row for every serial; `census_complete` (serials seen >= 98 % of
--     mint_cap) gates any share a reader shows, as the Top Shot squeeze "Top 5 hold" does (10-03, 10256).
--
-- Created WITH NO DATA because the MCP client caps a statement at 60 s; the first fill runs from pg_cron through
-- refresh_panini_holder_concentration(), which does a plain REFRESH when unpopulated and CONCURRENTLY after.
--
-- anon-exec: revoked (refresh_panini_holder_concentration) — new maintenance fn; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   select cron.unschedule('rpc-panini-holder-concentration');
--   drop function public.refresh_panini_holder_concentration();
--   drop materialized view public.mv_panini_holder_concentration;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_holder_concentration AS
WITH base AS (
  SELECT cs.edition_external_id AS ed,
         CASE WHEN cs.serial_state = 'BURNT' THEN 'burnt'
              WHEN cs.owner = '' OR cs.owner IS NULL THEN 'unowned'
              ELSE 'owned' END AS cat,
         CASE WHEN cs.serial_state = 'BURNT' OR cs.owner = '' OR cs.owner IS NULL THEN NULL ELSE cs.owner END AS owner,
         count(*)::int AS n
    FROM public.panini_card_serials cs
   GROUP BY 1, 2, 3
), ranked AS (
  SELECT ed, n, row_number() OVER (PARTITION BY ed ORDER BY n DESC, owner) AS rk
    FROM base WHERE cat = 'owned'
), per_ed AS (
  SELECT b.ed,
         sum(b.n)::int                                         AS serials_seen,
         COALESCE(sum(b.n) FILTER (WHERE b.cat = 'owned'), 0)::int   AS owned_copies,
         COALESCE(sum(b.n) FILTER (WHERE b.cat = 'unowned'), 0)::int AS unopened_copies,
         COALESCE(sum(b.n) FILTER (WHERE b.cat = 'burnt'), 0)::int   AS burnt_copies,
         count(*) FILTER (WHERE b.cat = 'owned')::int          AS holders
    FROM base b
   GROUP BY b.ed
), tops AS (
  SELECT ed,
         COALESCE(max(n) FILTER (WHERE rk = 1), 0)::int  AS top1_copies,
         COALESCE(sum(n) FILTER (WHERE rk <= 3), 0)::int AS top3_copies
    FROM ranked GROUP BY ed
), pe AS (
  SELECT DISTINCT ON (e.external_id) e.external_id, e.player_name, e.set_name, e.parallel, e.tier::text AS tier,
         e.mint_cap, e.product_set_id
    FROM public.panini_editions e
   ORDER BY e.external_id, e.updated_at DESC NULLS LAST
)
SELECT p.ed                                   AS external_id,
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
       COALESCE(t.top1_copies, 0)             AS top1_copies,
       COALESCE(t.top3_copies, 0)             AS top3_copies,
       CASE WHEN p.owned_copies > 0 THEN round(COALESCE(t.top1_copies, 0)::numeric / p.owned_copies, 4) END AS top1_share,
       CASE WHEN p.owned_copies > 0 THEN round(COALESCE(t.top3_copies, 0)::numeric / p.owned_copies, 4) END AS top3_share,
       (pe.mint_cap > 0 AND p.serials_seen >= 0.98 * pe.mint_cap) AS census_complete,
       now()                                  AS computed_at
  FROM per_ed p
  LEFT JOIN tops t ON t.ed = p.ed
  LEFT JOIN pe ON pe.external_id = p.ed
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_panini_holder_concentration_ext
  ON public.mv_panini_holder_concentration (external_id);

REVOKE ALL ON public.mv_panini_holder_concentration FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_holder_concentration TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_holder_concentration IS
  'Per-edition Panini holder concentration from panini_card_serials (counts only, no usernames). Blank owner = unopened, BURNT counted apart. census_complete gates shares. Refreshed daily by refresh_panini_holder_concentration(). audit_20261021.';

CREATE OR REPLACE FUNCTION public.refresh_panini_holder_concentration()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
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

REVOKE EXECUTE ON FUNCTION public.refresh_panini_holder_concentration() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_holder_concentration() TO postgres, service_role;

-- Daily at 5:29 AM PT (12:29 UTC): one 51 s sequential pass, an hour before the 6:29 AM shadow snapshot.
SELECT cron.schedule('rpc-panini-holder-concentration', '29 12 * * *',
  $$select public.refresh_panini_holder_concentration()$$);