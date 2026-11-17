-- Corrected challenge intelligence: cost/progress computed PER SLOT (cheapest eligible
-- moment per required lock), replacing the base-set-sum approximation that over-counted
-- required moments ~1.3-2x. Slots resolved via challenge_slot_editions.
-- Revert: restore bodies from audit_20260712_challenge_unify_cowork_roi.

-- 1) Cached wallet-agnostic cost = sum over slots of cheapest eligible (low_ask|fmv).
CREATE OR REPLACE FUNCTION public.refresh_challenge_costs(
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '120s'
AS $$
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
         WHERE dp.drop_weight > 0 AND dp.dist_id = c.reward_pack_dist_id AND fp.fmv_usd IS NOT NULL))
      WHEN c.reward_kind = 'moment' AND c.reward_moment_external_id IS NOT NULL THEN (
        SELECT mv.fmv_usd FROM public.mv_topshot_set_play_catalog mv
        WHERE mv.external_id = c.reward_moment_external_id LIMIT 1)
      ELSE NULL END)
  WHERE c.collection_id = p_collection_id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.refresh_challenge_costs(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_challenge_costs(uuid) TO service_role, postgres;

-- 2) Active board: per-slot cost + progress, wallet-aware. totalRequired = slot count.
CREATE OR REPLACE FUNCTION public.get_active_challenges(
  p_wallet text DEFAULT NULL,
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE collection_id = p_collection_id AND status = 'active'),
floor AS (
  SELECT be.external_id, MIN(NULLIF(be.low_ask,0)) AS low_ask
  FROM public.badge_editions be WHERE be.collection_id = p_collection_id GROUP BY be.external_id
),
slot AS (
  SELECT cse.challenge_id, cse.slot_order,
         MIN(COALESCE(fl.low_ask, mv.fmv_usd)) AS slot_cost,
         bool_or(p_wallet IS NOT NULL AND o.edition_key IS NOT NULL) AS owned
  FROM public.challenge_slot_editions cse
  JOIN ch ON ch.id = cse.challenge_id
  LEFT JOIN floor fl ON fl.external_id = cse.external_id
  LEFT JOIN public.mv_topshot_set_play_catalog mv ON mv.external_id = cse.external_id
  LEFT JOIN public.wallet_moments_cache o
    ON o.edition_key = cse.external_id AND o.collection_id = p_collection_id
   AND p_wallet IS NOT NULL AND lower(o.wallet_address) = lower(p_wallet)
  GROUP BY cse.challenge_id, cse.slot_order
),
totals AS (
  SELECT cs.challenge_id, count(*) AS total_slots FROM public.challenge_slots cs
  WHERE cs.challenge_id IN (SELECT id FROM ch) GROUP BY cs.challenge_id
),
agg AS (
  SELECT s.challenge_id,
    count(*) AS resolved_slots,
    count(*) FILTER (WHERE s.owned) AS filled_slots,
    SUM(s.slot_cost) FILTER (WHERE NOT s.owned)::numeric(12,2) AS cost_to_complete
  FROM slot s GROUP BY s.challenge_id
)
SELECT jsonb_build_object(
  'wallet', p_wallet, 'generatedAt', now(), 'activeCount', (SELECT COUNT(*) FROM ch),
  'challenges', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'challengeId', c.id, 'slug', c.slug, 'name', c.name, 'challengeType', c.challenge_type,
      'status', c.status, 'endsAt', c.ends_at, 'imageUrl', c.image_url, 'setName', c.set_name,
      'rewardKind', c.reward_kind, 'rewardLabel', c.reward_label,
      'totalRewardAllocation', c.total_reward_allocation, 'completedCount', c.completed_count,
      'packsPerUser', ROUND(c.total_reward_allocation::numeric / NULLIF(c.completed_count, 0), 2),
      'totalRequired', COALESCE(t.total_slots, 0),
      'ownedCount', COALESCE(a.filled_slots, 0),
      'missingCount', COALESCE(t.total_slots,0) - COALESCE(a.filled_slots,0),
      'unresolvedSlots', COALESCE(t.total_slots,0) - COALESCE(a.resolved_slots,0),
      'completionPct', ROUND(100.0 * COALESCE(a.filled_slots,0)::numeric / NULLIF(t.total_slots,0), 1),
      'costToComplete', a.cost_to_complete, 'entryFloor', c.cached_entry_floor,
      'rewardValue', c.cached_reward_value,
      'netEv', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                    ELSE ROUND(c.cached_reward_value - a.cost_to_complete, 2) END,
      'worthIt', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                      ELSE (c.cached_reward_value - a.cost_to_complete) > 0 END)
      ORDER BY (c.cached_reward_value - a.cost_to_complete) DESC NULLS LAST, c.ends_at ASC NULLS LAST)
    FROM ch c LEFT JOIN totals t ON t.challenge_id = c.id LEFT JOIN agg a ON a.challenge_id = c.id), '[]'::jsonb)
)
$function$;
REVOKE ALL ON FUNCTION public.get_active_challenges(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_challenges(text,uuid) TO service_role, authenticated, postgres;
