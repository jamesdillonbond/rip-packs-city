-- Unify the Cowork Set-Challenge ROI board (set_challenges + v_set_challenge_roi) onto the
-- canonical challenges pipeline (Trevor decision 2026-07-12: "unify onto A, keep artifact").
-- This file captures the DDL applied live via MCP; the one-time data backfill (31 rows
-- set_challenges -> challenges, reward-pack dist link, base-set challenge_editions) is a
-- data op recorded in docs/overnight/ledger.md, not re-run here.
--
-- Pieces:
--   1. challenges gains set_name + cached cost/reward columns (board reads cached → fast).
--   2. refresh_challenge_costs() bulk-computes cached cost/entry-floor/reward (drop-pool
--      valuation for reward packs, which aren't in pack_ev_latest). Daily pg_cron job
--      'rpc-refresh-challenge-costs' @ 07:20 UTC.
--   3. get_active_challenges / get_challenge_plan source FMV from mv_topshot_set_play_catalog
--      (indexed) instead of a per-edition DISTINCT-ON over partitioned fmv_snapshots, and read
--      the cached reward value — both were timing out on the ~1,393-edition base-set approximation.
--   4. v_set_challenge_roi repointed from set_challenges to challenges (same 18 output columns,
--      so the Cowork artifact is unaffected).
-- Revert: recreate v_set_challenge_roi.norm FROM set_challenges; DROP the cached columns +
--   refresh fn + cron; restore the fmv_snapshots-based RPC bodies from migration history.

-- 1 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.challenges
  ADD COLUMN IF NOT EXISTS set_name text,
  ADD COLUMN IF NOT EXISTS cached_cost_to_complete numeric(12,2),
  ADD COLUMN IF NOT EXISTS cached_entry_floor numeric(12,2),
  ADD COLUMN IF NOT EXISTS cached_reward_value numeric(12,2),
  ADD COLUMN IF NOT EXISTS cost_refreshed_at timestamptz;

-- 2 ─────────────────────────────────────────────────────────────────────────
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
  costs AS (
    SELECT ce.challenge_id,
      SUM(COALESCE(fl.low_ask, mv.fmv_usd))::numeric(12,2) AS cost,
      MIN(COALESCE(fl.low_ask, mv.fmv_usd))::numeric(12,2) AS entry_floor
    FROM public.challenge_editions ce
    LEFT JOIN floor fl ON fl.external_id = ce.external_id
    LEFT JOIN public.mv_topshot_set_play_catalog mv ON mv.external_id = ce.external_id
    GROUP BY ce.challenge_id
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
-- Daily refresh (applied live): SELECT cron.schedule('rpc-refresh-challenge-costs','20 7 * * *',
--   $$SELECT public.refresh_challenge_costs();$$);

-- 3 ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_active_challenges(
  p_wallet text DEFAULT NULL,
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE collection_id = p_collection_id AND status = 'active'),
totals AS (
  SELECT ce.challenge_id, COUNT(*) AS total_required
  FROM public.challenge_editions ce WHERE ce.challenge_id IN (SELECT id FROM ch)
  GROUP BY ce.challenge_id
),
owned AS (
  SELECT ce.challenge_id, COUNT(*) AS owned_count
  FROM public.challenge_editions ce
  JOIN public.wallet_moments_cache wmc
    ON wmc.edition_key = ce.external_id AND wmc.collection_id = p_collection_id
   AND p_wallet IS NOT NULL AND lower(wmc.wallet_address) = lower(p_wallet)
  WHERE ce.challenge_id IN (SELECT id FROM ch) GROUP BY ce.challenge_id
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
      'totalRequired', COALESCE(t.total_required, 0), 'ownedCount', COALESCE(o.owned_count, 0),
      'missingCount', COALESCE(t.total_required, 0) - COALESCE(o.owned_count, 0),
      'completionPct', ROUND(100.0 * COALESCE(o.owned_count, 0)::numeric / NULLIF(t.total_required, 0), 1),
      'costToComplete', c.cached_cost_to_complete, 'entryFloor', c.cached_entry_floor,
      'rewardValue', c.cached_reward_value,
      'netEv', CASE WHEN c.cached_reward_value IS NULL OR c.cached_cost_to_complete IS NULL THEN NULL
                    ELSE ROUND(c.cached_reward_value - c.cached_cost_to_complete, 2) END,
      'worthIt', CASE WHEN c.cached_reward_value IS NULL OR c.cached_cost_to_complete IS NULL THEN NULL
                      ELSE (c.cached_reward_value - c.cached_cost_to_complete) > 0 END)
      ORDER BY (c.cached_reward_value - c.cached_cost_to_complete) DESC NULLS LAST, c.ends_at ASC NULLS LAST)
    FROM ch c LEFT JOIN totals t ON t.challenge_id = c.id LEFT JOIN owned o ON o.challenge_id = c.id), '[]'::jsonb)
)
$function$;
REVOKE ALL ON FUNCTION public.get_active_challenges(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_challenges(text,uuid) TO service_role, authenticated, postgres;

CREATE OR REPLACE FUNCTION public.get_challenge_plan(p_wallet text, p_challenge_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE id = p_challenge_id),
req AS (SELECT ce.external_id, ce.play_id_onchain FROM public.challenge_editions ce WHERE ce.challenge_id = p_challenge_id),
floor AS (
  SELECT be.external_id, MIN(NULLIF(be.low_ask,0)) AS low_ask,
         MAX(be.lock_rate_pct) AS lock_rate_pct, MAX(be.burn_rate_pct) AS burn_rate_pct
  FROM public.badge_editions be
  WHERE be.collection_id = (SELECT collection_id FROM ch) AND be.external_id IN (SELECT external_id FROM req)
  GROUP BY be.external_id
),
owned AS (
  SELECT DISTINCT wmc.edition_key FROM public.wallet_moments_cache wmc
  WHERE lower(wmc.wallet_address) = lower(p_wallet) AND wmc.collection_id = (SELECT collection_id FROM ch)
    AND wmc.edition_key IN (SELECT external_id FROM req)
),
base AS (
  SELECT r.external_id, r.play_id_onchain, e.id AS edition_id, e.player_name,
         e.tier::text AS tier, e.thumbnail_url, mv.fmv_usd, fl.low_ask,
         fl.lock_rate_pct, fl.burn_rate_pct, (o.edition_key IS NOT NULL) AS owned
  FROM req r
  LEFT JOIN public.editions e ON e.external_id = r.external_id AND e.collection_id = (SELECT collection_id FROM ch)
  LEFT JOIN public.mv_topshot_set_play_catalog mv ON mv.external_id = r.external_id
  LEFT JOIN floor fl ON fl.external_id = r.external_id
  LEFT JOIN owned o  ON o.edition_key = r.external_id
),
agg AS (
  SELECT COUNT(*) AS total_required, COUNT(*) FILTER (WHERE owned) AS owned_count,
    COALESCE(SUM(CASE WHEN NOT owned THEN COALESCE(low_ask, fmv_usd) ELSE 0 END), 0)::numeric(12,2) AS cost_to_complete,
    COALESCE(SUM(CASE WHEN owned THEN fmv_usd ELSE 0 END), 0)::numeric(12,2) AS owned_value
  FROM base
)
SELECT jsonb_build_object(
  'challengeId', ch.id, 'slug', ch.slug, 'name', ch.name, 'challengeType', ch.challenge_type,
  'description', ch.description, 'status', ch.status, 'startsAt', ch.starts_at, 'endsAt', ch.ends_at,
  'setName', ch.set_name, 'totalRewardAllocation', ch.total_reward_allocation, 'completedCount', ch.completed_count,
  'rewardKind', ch.reward_kind, 'rewardLabel', ch.reward_label, 'imageUrl', ch.image_url,
  'wallet', p_wallet, 'totalRequired', a.total_required, 'ownedCount', a.owned_count,
  'missingCount', a.total_required - a.owned_count,
  'completionPct', ROUND(100.0 * a.owned_count::numeric / NULLIF(a.total_required, 0), 1),
  'costToComplete', a.cost_to_complete, 'ownedValue', a.owned_value, 'rewardValue', ch.cached_reward_value,
  'netEv', CASE WHEN ch.cached_reward_value IS NULL THEN NULL ELSE ROUND(ch.cached_reward_value - a.cost_to_complete, 2) END,
  'worthIt', CASE WHEN ch.cached_reward_value IS NULL THEN NULL ELSE (ch.cached_reward_value - a.cost_to_complete) > 0 END,
  'owned', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('externalId', b.external_id, 'playId', b.play_id_onchain,
      'playerName', b.player_name, 'tier', b.tier, 'thumbnailUrl', b.thumbnail_url,
      'fmvUsd', b.fmv_usd, 'lockRatePct', b.lock_rate_pct) ORDER BY b.player_name)
    FROM base b WHERE b.owned), '[]'::jsonb),
  'missing', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('externalId', b.external_id, 'playId', b.play_id_onchain,
      'playerName', b.player_name, 'tier', b.tier, 'thumbnailUrl', b.thumbnail_url,
      'fmvUsd', b.fmv_usd, 'lowAsk', b.low_ask, 'lockRatePct', b.lock_rate_pct, 'burnRatePct', b.burn_rate_pct,
      'editionUrl', '/nba-top-shot/edition/' || b.external_id)
      ORDER BY COALESCE(b.low_ask, b.fmv_usd) ASC NULLS LAST, b.player_name)
    FROM base b WHERE NOT b.owned), '[]'::jsonb)
)
FROM ch CROSS JOIN agg a;
$function$;
REVOKE ALL ON FUNCTION public.get_challenge_plan(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_plan(text,uuid) TO service_role, authenticated, postgres;

-- 4 ─────────────────────────────────────────────────────────────────────────
-- v_set_challenge_roi repointed from set_challenges to challenges. Full body applied live in
-- migration audit_20260712_set_challenge_roi_view_onto_challenges (norm CTE now reads
-- FROM public.challenges WHERE status='active' AND set_name IS NOT NULL; all other CTEs +
-- the 18 output columns unchanged, so the Cowork artifact is unaffected).
