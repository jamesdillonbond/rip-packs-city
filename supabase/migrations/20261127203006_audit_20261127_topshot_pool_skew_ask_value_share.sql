-- audit_20261127_topshot_pool_skew_ask_value_share
--
-- 11-27 (Trevor: "Keep going"): the ONLY Top Shot pack showing +EV against a live ask on the board at
-- 12:40 PM PT was Memphis Grizzlies Leaderboard Reward: Fit Check (Diced) — "+58.3 % EV margin", $315 EV vs
-- a $199 pack ask — and 100 % of that EV is one never-sold /10 Moment priced at 0.9 x its own $350 ask
-- (ASK_ONLY, days_since_sale NULL). Pinnacle already shows the basis fact for this shape ("from asks":
-- N % of the EV rests on asking prices for items that have barely traded); Top Shot had no such measure.
-- This adds it: ask_value_share = remaining-weighted FMV value on never-sold ASK_ONLY editions / all
-- remaining priced value. Read by lib/packs/pool-skew.ts (>= 50 % shows the existing "from asks" marker).
--
-- "Never sold" = the edition's current fmv_snapshots row (matched on edition_fmv_current.computed_at) has
-- days_since_sale NULL — measured 11-27: 2,265 never-sold vs 1,418 previously-sold ASK_ONLY editions in
-- pools. A previously-sold edition relabelled ASK_ONLY after 30 days backtests well (60 % within +/-25 %,
-- topshot-never-sold-no-comps-ask-price-2026-11-27.md), so it is NOT counted.
--
-- Revert: ALTER TABLE public.topshot_pool_skew DROP COLUMN ask_value_share; re-apply the function body
-- from 20261127184627.

ALTER TABLE public.topshot_pool_skew ADD COLUMN IF NOT EXISTS ask_value_share numeric;

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
    (dist_id, editions_listed, listed_share, skew, fmv_coverage, pool_fetched_at, ask_value_share, computed_at)
  SELECT s.d,
         s.n,
         CASE WHEN p.total_minted > 0 AND p.slots > 0
              THEN round(s.o::numeric / (p.total_minted::numeric * p.slots), 4) END,
         CASE WHEN s.launch_mean > 0 THEN round(s.now_mean / s.launch_mean, 4) END,
         round(COALESCE(s.r_priced::numeric / NULLIF(s.r, 0), 0), 4),
         s.oldest,
         CASE WHEN s.r_value > 0 THEN round(COALESCE(s.r_value_unsold_ask, 0) / s.r_value, 4) END,
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
             sum(x.remaining_count * f.fmv_usd) AS r_value,
             sum(x.remaining_count * f.fmv_usd)
               FILTER (WHERE f.confidence = 'ASK_ONLY' AND u.never_sold) AS r_value_unsold_ask,
             min(x.fetched_at) AS oldest
        FROM public.topshot_atlas_dist_editions x
        LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id::text = x.atlas_edition_id::text
        LEFT JOIN public.edition_fmv_current f ON f.edition_id = m.rpc_edition_id
        LEFT JOIN LATERAL (
          SELECT (fs.days_since_sale IS NULL) AS never_sold
            FROM public.fmv_snapshots fs
           WHERE f.confidence = 'ASK_ONLY'
             AND fs.edition_id = f.edition_id AND fs.computed_at = f.computed_at
           LIMIT 1
        ) u ON true
       GROUP BY 1
    ) s
    LEFT JOIN public.pack_table_rows p ON p.dist_id = s.d AND p.collection_slug = 'nba-top-shot'
  ON CONFLICT (dist_id) DO UPDATE SET
    editions_listed = EXCLUDED.editions_listed,
    listed_share    = EXCLUDED.listed_share,
    skew            = EXCLUDED.skew,
    fmv_coverage    = EXCLUDED.fmv_coverage,
    pool_fetched_at = EXCLUDED.pool_fetched_at,
    ask_value_share = EXCLUDED.ask_value_share,
    computed_at     = EXCLUDED.computed_at;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  DELETE FROM public.topshot_pool_skew WHERE computed_at < v_run;
  RETURN v_written;
END
$fn$;
-- anon-exec: unchanged (refresh_topshot_pool_skew) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false 11-27.

SELECT public.refresh_topshot_pool_skew();
