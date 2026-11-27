-- audit_20261127_topshot_pool_survivor_skew
--
-- Trevor 2026-11-27: "Do what you think is best, without adding extra noise". The packs board and
-- pack pages call a Top Shot pack "survivor-biased" (grey margin, "🔥 N% opened", EV blanked to a
-- ceiling) whenever its pool is >= 60/70/90 % drawn. Measured 11-27 over ~40 multi-edition pools
-- 97-99 % drawn: standard packs (Base Set, Playoffs, Run It Back 2005-06) still hold their launch mix
-- (remaining-weighted mean FMV / launch-weighted mean FMV ~ 1.0), chase packs do not (Grail Seekers
-- February 5.6x, Top Shot Debut Chance Hit 4.1x). This table measures the mix per pool so the board can
-- stop warning where the mix is measurably flat. It never ADDS a warning; absent or unmeasurable rows
-- keep today's depletion behaviour.
--
-- Caveat built into listed_share: topshot_atlas_dist_editions never stores a remaining_count = 0 row
-- (a sold-out edition vanishes from it), so skew is measured over the editions still listed. Where
-- whole editions vanished (listed_share = listed launch copies / (total_minted x slots) < 0.95, e.g.
-- dist 5223 at 0.10) the mix is UNMEASURABLE and the app keeps warning.
--
-- Revert: SELECT cron.unschedule('rpc-topshot-pool-skew'); DROP FUNCTION public.refresh_topshot_pool_skew();
--         DROP TABLE public.topshot_pool_skew;  (the app treats a missing row as "unmeasured")

CREATE TABLE IF NOT EXISTS public.topshot_pool_skew (
  dist_id          text PRIMARY KEY,
  editions_listed  integer NOT NULL,
  listed_share     numeric,           -- listed launch copies / (total_minted x slots); NULL = no supply figure
  skew             numeric,           -- remaining-weighted mean FMV / launch-weighted mean FMV, over listed editions
  fmv_coverage     numeric NOT NULL,  -- share of REMAINING copies whose edition has an FMV
  pool_fetched_at  timestamptz NOT NULL, -- oldest Atlas read in the pool (the measure is only as fresh as this)
  computed_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_pool_skew ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topshot_pool_skew_read ON public.topshot_pool_skew;
CREATE POLICY topshot_pool_skew_read ON public.topshot_pool_skew FOR SELECT USING (true);
REVOKE ALL ON public.topshot_pool_skew FROM anon, authenticated;
GRANT SELECT ON public.topshot_pool_skew TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_topshot_pool_skew()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_written integer;
  v_run timestamptz := clock_timestamp();
BEGIN
  -- Write first, then delete only rows this run did not write (R123 ordering).
  INSERT INTO public.topshot_pool_skew AS t
    (dist_id, editions_listed, listed_share, skew, fmv_coverage, pool_fetched_at, computed_at)
  SELECT s.d,
         s.n,
         CASE WHEN p.total_minted > 0 AND p.slots > 0
              THEN round(s.o::numeric / (p.total_minted::numeric * p.slots), 4) END,
         CASE WHEN s.launch_mean > 0 THEN round(s.now_mean / s.launch_mean, 4) END,
         round(COALESCE(s.r_priced::numeric / NULLIF(s.r, 0), 0), 4),
         s.oldest,
         v_run
    FROM (
      SELECT x.dist_id::text AS d,
             count(*)::int AS n,
             sum(x.original_count) AS o,
             sum(x.remaining_count) AS r,
             sum(x.remaining_count) FILTER (WHERE f.fmv_usd IS NOT NULL) AS r_priced,
             sum(x.original_count * f.fmv_usd)
               / NULLIF(sum(x.original_count) FILTER (WHERE f.fmv_usd IS NOT NULL), 0) AS launch_mean,
             sum(x.remaining_count * f.fmv_usd)
               / NULLIF(sum(x.remaining_count) FILTER (WHERE f.fmv_usd IS NOT NULL), 0) AS now_mean,
             min(x.fetched_at) AS oldest
        FROM public.topshot_atlas_dist_editions x
        LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id::text = x.atlas_edition_id::text
        LEFT JOIN public.edition_fmv_current f ON f.edition_id = m.rpc_edition_id
       GROUP BY 1
    ) s
    LEFT JOIN public.pack_table_rows p ON p.dist_id = s.d AND p.collection_slug = 'nba-top-shot'
  ON CONFLICT (dist_id) DO UPDATE SET
    editions_listed = EXCLUDED.editions_listed,
    listed_share    = EXCLUDED.listed_share,
    skew            = EXCLUDED.skew,
    fmv_coverage    = EXCLUDED.fmv_coverage,
    pool_fetched_at = EXCLUDED.pool_fetched_at,
    computed_at     = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  DELETE FROM public.topshot_pool_skew WHERE computed_at < v_run;
  RETURN v_written;
END
$fn$;
-- anon-exec: revoked (refresh_topshot_pool_skew) — new writer fn; pg_cron (postgres) is its only caller.
REVOKE EXECUTE ON FUNCTION public.refresh_topshot_pool_skew() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_pool_skew() TO postgres, service_role;

SELECT public.refresh_topshot_pool_skew();

select cron.schedule('rpc-topshot-pool-skew', '23 * * * *', $$SELECT public.refresh_topshot_pool_skew()$$);
