-- audit_20260713_challenge_reward_value_secondary_sale_fallback
-- Adds a 3rd COALESCE fallback for pack reward value = the reward pack's own recent
-- secondary-sale median (>=2 sales / 90d), for challenges whose reward pack is neither in
-- pack_ev_latest nor has an indexed drop pool. Additive; same signature (no grant reset);
-- existing values untouched (fallback only fills prior-null). Applied live via Supabase MCP
-- 2026-07-13 (reward-null active challenges 19 -> 7). Repo/DB parity for the live definition;
-- supersedes the reward branch in 20260713032000_audit_20260713_challenge_rpcs_per_slot.sql.
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

  UPDATE public.challenges c SET cached_reward_value = (
    CASE
      WHEN c.reward_kind = 'pack' AND c.reward_pack_dist_id IS NOT NULL THEN COALESCE(
        (SELECT pe.gross_ev FROM public.pack_ev_latest pe
         WHERE pe.dist_id = c.reward_pack_dist_id AND pe.collection_id = c.collection_id LIMIT 1),
        (SELECT round(sum(fp.fmv_usd * dp.drop_weight) / NULLIF(sum(dp.drop_weight), 0), 2)
         FROM public.pack_drop_pool dp
         JOIN LATERAL (SELECT fs.fmv_usd FROM public.fmv_snapshots fs
                        WHERE fs.edition_id = dp.edition_id ORDER BY fs.computed_at DESC LIMIT 1) fp ON true
         WHERE dp.drop_weight > 0 AND dp.dist_id = c.reward_pack_dist_id AND fp.fmv_usd IS NOT NULL),
        (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pp.sale_price)::numeric, 2)
         FROM public.pack_purchases pp
         WHERE pp.pack_dist_id = c.reward_pack_dist_id
           AND pp.event_kind = 'secondary_sale'
           AND pp.sale_price > 0
           AND pp.sealed_at > now() - interval '90 days'
         HAVING count(*) >= 2))
      WHEN c.reward_kind = 'moment' AND c.reward_moment_external_id IS NOT NULL THEN (
        SELECT mv.fmv_usd FROM public.mv_topshot_set_play_catalog mv
        WHERE mv.external_id = c.reward_moment_external_id LIMIT 1)
      ELSE NULL END)
  WHERE c.collection_id = p_collection_id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $function$;
