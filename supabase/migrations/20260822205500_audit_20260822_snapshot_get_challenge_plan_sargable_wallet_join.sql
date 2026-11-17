-- Snapshot migration: public.get_challenge_plan(text,uuid).
--
-- Commits the CURRENT LIVE definition verbatim (pg_get_functiondef read 2026-08-22;
-- byte-identical, md5 cfc1fa0259b7ea24dcdf8e7ecdbb47e8 — verified against the
-- database's own md5, not by eye). Applying it is a NO-OP against prod.
--
-- WHY IT EXISTS. `db-pin-staleness` had reported this pin STALE on every run since
-- 2026-08-10 (known-issues #24). It drifted in the SAME pass as its sibling
-- get_active_challenges, and the substantive change is the same one line — the
-- `owned` CTE moved from
--     -  lower(wmc.wallet_address) = lower(p_wallet)
--     +  wmc.wallet_address IN (p_wallet, lower(p_wallet))
-- making the predicate sargable (a lower() on the column cannot use an index).
-- ⚠ The only other difference is a DROPPED COMMENT on the `pick` CTE, which is why
-- the body got 57 characters SHORTER while the predicate grew by 6. A size delta is
-- not a change summary.
--
-- ⚠ IT IS ALSO A SEMANTIC NARROWING: a stored address whose case differs from BOTH
-- the argument and its lowercase form no longer matches, so its slots read as
-- UNOWNED and costToComplete reads as full price on the buy recommendation.
-- ⚠ MEASURED 2026-08-22 and currently harmless: 384 mixed-case wallets in
-- wallet_moments_cache, none with a lowercase duplicate; 436 wallets own a challenge
-- slot edition all-time; the two sets are DISJOINT. The first reading of this looked
-- like a live pricing defect and was refuted only by a positive control.
-- The pinned test asserts the case semantics AND that the miss shows up in the price.
--
-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged — get_challenge_plan is ALREADY revoked in prod. Verified
-- 2026-08-22 with has_function_privilege (not the acl text): anon EXECUTE false,
-- authenticated EXECUTE false, service_role EXECUTE true.
-- ⚠ Deliberately a MARKER and not a REVOKE: byte-identical snapshot, and CREATE OR
-- REPLACE FUNCTION does NOT reset a function's ACL, so a REVOKE here would CHANGE
-- production while presenting itself as a no-op.
--
-- REVERT: none needed — a no-op capture of what prod already runs.

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
  'netEv', CASE WHEN ch.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL ELSE ROUND(ch.cached_reward_value * GREATEST(COALESCE(ch.total_reward_allocation::numeric / NULLIF(ch.completed_count,0), 1), 1) - a.cost_to_complete, 2) END,
  'worthIt', CASE WHEN ch.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL ELSE (ch.cached_reward_value * GREATEST(COALESCE(ch.total_reward_allocation::numeric / NULLIF(ch.completed_count,0), 1), 1) - a.cost_to_complete) > 0 END,
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
