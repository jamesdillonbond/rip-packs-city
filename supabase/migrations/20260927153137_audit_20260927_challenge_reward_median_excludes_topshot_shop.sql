-- 2026-09-27 — challenge reward values priced three reward packs from the TOP SHOT
-- SHOP, not from collectors (known-issues #134, the falsifier it names).
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────────
-- `refresh_challenge_costs` falls back to the median `pack_purchases` sale when a
-- reward pack has no pack-EV (it never does — see 20260902120329). Both median arms
-- filtered `event_kind = 'secondary_sale'` only. Top Shot's own shop sales are
-- written with that same event_kind (`custom_id 'nba'`, one storefront
-- 250688653852667, a fixed price per dist), so the shop price sat inside a
-- "collector market" median. #134 made every other collector-market reader filter
-- `custom_id IS DISTINCT FROM 'nba'` on 09-24/25; this one was missed.
--
-- ── MEASURED 2026-09-27 ~8:40 AM PT (90-day window, the function's own) ────────
--   dist  title (Set Completion Reward)       shop rows  resale rows  stored  resale median
--   8552  Video Game Numbers                  5,750 @$9          74    9.00          17.00
--   8554  Heat Check                             31 @$9          75   15.99          17.75
--   8560  Run It Back: Playoff Classics           4 @$5           3    5.00         360.00
-- 8552's shop run was 5,742 sales at $9 to 700 buyers (08-18 → 09-10) — real shop
-- sales, so the label is right and the reader is wrong. 8560 read $5 against three
-- resales of $350–$365. All three challenges are `status = 'ended'`; no live
-- challenge is affected today, but every future shop-sold reward pack would be.
--
-- ── DECISION (standing delegation) ─────────────────────────────────────────────
-- A reward's value is what it is worth to a COLLECTOR, i.e. resale — the same rule
-- every other collector-market reader follows. The shop price is a retail price and
-- is not a valuation. The one-token change: both median arms add
-- `AND pp.custom_id IS DISTINCT FROM 'nba'`. Nothing else changes; the hoisted
-- `_pack_ev` table and the arm order are byte-identical to 20260902120329.
--
-- ── REVERT ─────────────────────────────────────────────────────────────────────
-- Re-apply the CREATE OR REPLACE body from
-- supabase/migrations/20260902120329_audit_20260902_challenge_costs_arm1_hoisted_out_of_the_per_row_loop.sql,
-- then `SELECT public.refresh_challenge_costs();`.

-- anon-exec: unchanged-by-replace (refresh_challenge_costs) — CREATE OR REPLACE of an
-- existing function with the same signature does not reset its ACL. Verified live
-- before applying: acl is `postgres=X/postgres, service_role=X/postgres`.

CREATE OR REPLACE FUNCTION public.refresh_challenge_costs(p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE v_n integer;
BEGIN
  WITH floor AS (
    SELECT be.external_id, MIN(NULLIF(be.low_ask,0)) AS low_ask
    FROM public.badge_editions be WHERE be.collection_id = p_collection_id
    GROUP BY be.external_id
  ),
  slot_cost AS (
    SELECT cse.challenge_id, cse.slot_order,
           MIN(COALESCE(fl.low_ask, mv.fmv_usd)) AS cost
    FROM public.challenge_slot_editions cse
    LEFT JOIN floor fl ON fl.external_id = cse.external_id
    LEFT JOIN public.mv_topshot_set_play_catalog mv ON mv.external_id = cse.external_id
    GROUP BY cse.challenge_id, cse.slot_order
  ),
  costs AS (
    SELECT sc.challenge_id,
           SUM(sc.cost)::numeric(12,2) AS cost,
           MIN(sc.cost)::numeric(12,2) AS entry_floor
    FROM slot_cost sc GROUP BY sc.challenge_id
  )
  UPDATE public.challenges c SET
    cached_cost_to_complete = costs.cost, cached_entry_floor = costs.entry_floor, cost_refreshed_at = now()
  FROM costs WHERE c.id = costs.challenge_id;

  -- ⛔ HOISTED ON PURPOSE — DO NOT INLINE THIS BACK INTO THE COALESCE BELOW.
  -- pack_ev_latest is a DISTINCT ON view, so a correlated subquery against it
  -- re-materialises the entire view once per challenge row: 40,716 ms and
  -- 21,094,324 buffers for 31 rows, which is 99.7% of this function's cost and the
  -- reason jobid 87 hit the 120 s wall on 15% of its runs. Computed once here it is
  -- 1,220 ms / 681,430 buffers.
  DROP TABLE IF EXISTS _pack_ev;
  CREATE TEMP TABLE _pack_ev ON COMMIT DROP AS
  SELECT DISTINCT ON (pe.dist_id) pe.dist_id, pe.gross_ev
  FROM public.pack_ev_latest pe
  WHERE pe.collection_id = p_collection_id
  ORDER BY pe.dist_id, pe.snapshotted_at DESC;
  CREATE INDEX ON _pack_ev (dist_id);

  UPDATE public.challenges c SET cached_reward_value = (
    CASE
      WHEN c.reward_kind = 'pack' AND c.reward_pack_dist_id IS NOT NULL THEN COALESCE(
        (SELECT pv.gross_ev FROM _pack_ev pv WHERE pv.dist_id = c.reward_pack_dist_id),
        (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.sale_price)::numeric, 2)
         FROM public.pack_purchases pp
         WHERE pp.pack_dist_id = c.reward_pack_dist_id AND pp.event_kind = 'secondary_sale'
           AND pp.custom_id IS DISTINCT FROM 'nba'
           AND pp.sale_price > 0 AND pp.sealed_at > now() - interval '90 days'
         HAVING count(*) >= 3),
        (SELECT round(sum(fp.fmv_usd * dp.drop_weight) / NULLIF(sum(dp.drop_weight), 0), 2)
         FROM public.pack_drop_pool dp
         JOIN LATERAL (SELECT fs.fmv_usd FROM public.fmv_snapshots fs
                        WHERE fs.edition_id = dp.edition_id ORDER BY fs.computed_at DESC LIMIT 1) fp ON true
         WHERE dp.drop_weight > 0 AND dp.dist_id = c.reward_pack_dist_id AND fp.fmv_usd IS NOT NULL),
        (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.sale_price)::numeric, 2)
         FROM public.pack_purchases pp
         WHERE pp.pack_dist_id = c.reward_pack_dist_id AND pp.event_kind = 'secondary_sale'
           AND pp.custom_id IS DISTINCT FROM 'nba'
           AND pp.sale_price > 0 AND pp.sealed_at > now() - interval '90 days'
         HAVING count(*) >= 2))
      WHEN c.reward_kind = 'moment' AND c.reward_moment_external_id IS NOT NULL THEN (
        SELECT mv.fmv_usd FROM public.mv_topshot_set_play_catalog mv
        WHERE mv.external_id = c.reward_moment_external_id LIMIT 1)
      ELSE NULL END)
  WHERE c.collection_id = p_collection_id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $function$;
