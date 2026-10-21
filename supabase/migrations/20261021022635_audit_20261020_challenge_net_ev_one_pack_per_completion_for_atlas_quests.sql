-- audit_20261020_challenge_net_ev_one_pack_per_completion_for_atlas_quests
-- anon-exec: unchanged — get_active_challenges and get_challenge_plan are already revoked from anon/authenticated (CREATE OR REPLACE keeps the ACL; verified 2026-08-22, not re-granted here).
--
-- The challenge board's netEv / worthIt multiply the reward by "packs per completer" =
-- total_reward_allocation / completed_count, a model from the old searchChallenges feed. For the
-- Atlas QuestService challenges ingested since 2026-10-20 (source='atlas_quest') that is wrong:
-- `maxCompletions` (stored as total_reward_allocation) CAPS how many people can finish, each finisher
-- gets ONE reward pack (maxCompletionsPerUser = 1, rewardQuantity = 1). Measured on the first ingest
-- (2026-10-20 ~7:35 PM PT): Run It Back: Origins read netEv +$44.57 / worthIt=true from 129 x 340/85 -
-- 471.43, when one pack worth $129.00 against $471.43 to complete is -$342.43. A false "worth it" on a
-- user-facing board and the concierge.
-- Fix: the multiplier is 1 for source='atlas_quest' rows (and packsPerUser reads 1); every other row is
-- byte-for-byte the old formula. Both bodies were verified identical to live prosrc (md5
-- 535a8dee… / b7bee3bb…) immediately before this edit.
--
-- REVERT: re-apply the bodies in 20260822204500 and 20260822205500.

CREATE OR REPLACE FUNCTION public.get_active_challenges(p_wallet text DEFAULT NULL::text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE collection_id = p_collection_id AND status = 'active' AND (ends_at IS NULL OR ends_at > now())),
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
   AND p_wallet IS NOT NULL AND o.wallet_address IN (p_wallet, lower(p_wallet))
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
      'packsPerUser', CASE WHEN c.source = 'atlas_quest' THEN 1 ELSE ROUND(c.total_reward_allocation::numeric / NULLIF(c.completed_count, 0), 2) END,
      'totalRequired', COALESCE(t.total_slots, 0),
      'ownedCount', COALESCE(a.filled_slots, 0),
      'missingCount', COALESCE(t.total_slots,0) - COALESCE(a.filled_slots,0),
      'unresolvedSlots', COALESCE(t.total_slots,0) - COALESCE(a.resolved_slots,0),
      'completionPct', ROUND(100.0 * COALESCE(a.filled_slots,0)::numeric / NULLIF(t.total_slots,0), 1),
      'costToComplete', a.cost_to_complete, 'entryFloor', c.cached_entry_floor,
      'rewardValue', c.cached_reward_value,
      'netEv', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                    ELSE ROUND(c.cached_reward_value * CASE WHEN c.source = 'atlas_quest' THEN 1 ELSE GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) END - a.cost_to_complete, 2) END,
      'worthIt', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                      ELSE (c.cached_reward_value * CASE WHEN c.source = 'atlas_quest' THEN 1 ELSE GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) END - a.cost_to_complete) > 0 END)
      ORDER BY (c.cached_reward_value * CASE WHEN c.source = 'atlas_quest' THEN 1 ELSE GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) END - a.cost_to_complete) DESC NULLS LAST, c.ends_at ASC NULLS LAST)
    FROM ch c LEFT JOIN totals t ON t.challenge_id = c.id LEFT JOIN agg a ON a.challenge_id = c.id), '[]'::jsonb)
)
$function$;

CREATE OR REPLACE FUNCTION public.get_challenge_plan(p_wallet text, p_challenge_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
WITH ch AS (SELECT * FROM public.challenges WHERE id = p_challenge_id AND (ends_at IS NULL OR ends_at > now())),
floor AS (
  SELECT be.external_id, MIN(NULLIF(be.low_ask,0)) AS low_ask,
         MAX(be.lock_rate_pct) AS lock_rate_pct, MAX(be.burn_rate_pct) AS burn_rate_pct
  FROM public.badge_editions be
  WHERE be.collection_id = (SELECT collection_id FROM ch)
  GROUP BY be.external_id
),
owned AS (
  SELECT DISTINCT wmc.edition_key FROM public.wallet_moments_cache wmc
  WHERE wmc.wallet_address IN (p_wallet, lower(p_wallet)) AND wmc.collection_id = (SELECT collection_id FROM ch)
),
elig AS (
  SELECT cse.slot_order, cse.external_id, e.player_name, e.tier::text AS tier, e.thumbnail_url,
         mv.fmv_usd, fl.low_ask, fl.lock_rate_pct, fl.burn_rate_pct,
         COALESCE(fl.low_ask, mv.fmv_usd) AS cost,
         (o.edition_key IS NOT NULL) AS owned
  FROM public.challenge_slot_editions cse
  LEFT JOIN public.editions e ON e.external_id = cse.external_id AND e.collection_id = (SELECT collection_id FROM ch)
  LEFT JOIN public.mv_topshot_set_play_catalog mv ON mv.external_id = cse.external_id
  LEFT JOIN floor fl ON fl.external_id = cse.external_id
  LEFT JOIN owned o ON o.edition_key = cse.external_id
  WHERE cse.challenge_id = p_challenge_id
),
sm AS (SELECT slot_order, label, play_category, help_text FROM public.challenge_slots WHERE challenge_id = p_challenge_id),
slot_state AS (
  SELECT sm.slot_order, sm.label, sm.play_category, sm.help_text,
         COALESCE(bool_or(el.owned), false) AS filled,
         count(el.external_id) AS eligible_count,
         MIN(el.cost) FILTER (WHERE NOT el.owned) AS cheapest_unowned_cost
  FROM sm LEFT JOIN elig el ON el.slot_order = sm.slot_order
  GROUP BY sm.slot_order, sm.label, sm.play_category, sm.help_text
),
pick AS (
  SELECT DISTINCT ON (el.slot_order) el.slot_order, el.external_id, el.player_name, el.tier,
         el.thumbnail_url, el.fmv_usd, el.low_ask, el.lock_rate_pct, el.burn_rate_pct
  FROM elig el
  ORDER BY el.slot_order, el.cost ASC NULLS LAST, el.external_id
),
agg AS (
  SELECT
    count(*) AS total_slots,
    count(*) FILTER (WHERE filled) AS filled_slots,
    count(*) FILTER (WHERE eligible_count = 0) AS unresolved_slots,
    SUM(cheapest_unowned_cost) FILTER (WHERE NOT filled)::numeric(12,2) AS cost_to_complete
  FROM slot_state
)
SELECT jsonb_build_object(
  'challengeId', ch.id, 'slug', ch.slug, 'name', ch.name, 'challengeType', ch.challenge_type,
  'description', ch.description, 'status', ch.status, 'startsAt', ch.starts_at, 'endsAt', ch.ends_at,
  'setName', ch.set_name, 'totalRewardAllocation', ch.total_reward_allocation, 'completedCount', ch.completed_count,
  'rewardKind', ch.reward_kind, 'rewardLabel', ch.reward_label, 'imageUrl', ch.image_url,
  'wallet', p_wallet,
  'totalRequired', a.total_slots, 'ownedCount', a.filled_slots,
  'missingCount', a.total_slots - a.filled_slots, 'unresolvedSlots', a.unresolved_slots,
  'completionPct', ROUND(100.0 * a.filled_slots::numeric / NULLIF(a.total_slots, 0), 1),
  'costToComplete', a.cost_to_complete, 'rewardValue', ch.cached_reward_value,
  'netEv', CASE WHEN ch.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL ELSE ROUND(ch.cached_reward_value * CASE WHEN ch.source = 'atlas_quest' THEN 1 ELSE GREATEST(COALESCE(ch.total_reward_allocation::numeric / NULLIF(ch.completed_count,0), 1), 1) END - a.cost_to_complete, 2) END,
  'worthIt', CASE WHEN ch.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL ELSE (ch.cached_reward_value * CASE WHEN ch.source = 'atlas_quest' THEN 1 ELSE GREATEST(COALESCE(ch.total_reward_allocation::numeric / NULLIF(ch.completed_count,0), 1), 1) END - a.cost_to_complete) > 0 END,
  'slots', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'slotOrder', ss.slot_order, 'label', ss.label, 'playCategory', ss.play_category, 'helpText', ss.help_text,
      'filled', ss.filled, 'eligibleCount', ss.eligible_count,
      'pick', CASE WHEN p.external_id IS NULL THEN NULL ELSE jsonb_build_object(
        'externalId', p.external_id, 'playerName', p.player_name, 'tier', p.tier,
        'thumbnailUrl', p.thumbnail_url, 'fmvUsd', p.fmv_usd, 'lowAsk', p.low_ask,
        'lockRatePct', p.lock_rate_pct, 'burnRatePct', p.burn_rate_pct,
        'editionUrl', '/nba-top-shot/edition/' || p.external_id) END)
      ORDER BY ss.filled ASC, ss.cheapest_unowned_cost ASC NULLS LAST, ss.slot_order)
    FROM slot_state ss LEFT JOIN pick p ON p.slot_order = ss.slot_order), '[]'::jsonb)
)
FROM ch CROSS JOIN agg a;
$function$;
