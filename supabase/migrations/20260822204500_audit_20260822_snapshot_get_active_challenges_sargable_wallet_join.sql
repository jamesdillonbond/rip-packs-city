-- Snapshot migration: public.get_active_challenges(text,uuid).
--
-- Commits the CURRENT LIVE definition verbatim (pg_get_functiondef read 2026-08-22;
-- byte-identical, md5 7e7b0cb0f06982c32fe2bd16039bfad7 — verified against the
-- database's own md5, not by eye). Applying it is a NO-OP against prod.
--
-- WHY IT EXISTS. `db-pin-staleness` had reported this pin STALE on every run since
-- 2026-08-10 (known-issues #24). The ENTIRE drift is one line in the ownership join:
--     -  lower(o.wallet_address) = lower(p_wallet)
--     +  o.wallet_address IN (p_wallet, lower(p_wallet))
-- which makes the predicate sargable (wrapping the column in lower() cannot use an
-- index on wallet_address).
--
-- ⚠ IT IS ALSO A SEMANTIC NARROWING, and that is recorded here rather than left to
-- be rediscovered: a stored address whose case differs from BOTH the argument and
-- its lowercase form no longer matches, so its slots read as UNOWNED and
-- costToComplete reads as full price on the "is this challenge worth it" verdict.
--
-- ⚠ MEASURED 2026-08-22 and currently HARMLESS: 25,447 mixed-case rows across 384
-- wallets in wallet_moments_cache, none with a lowercase duplicate; 436 wallets own
-- a challenge slot edition all-time; the two sets are DISJOINT. All 31 challenges
-- are `ended` (latest 2026-07-16). ⚠ The first measurement looked like a live defect
-- and was refuted only by a positive control — an initial "0 affected wallets" was
-- vacuous because the active-challenge population is empty.
-- The pinned test now asserts the case semantics explicitly, with its own control.
--
-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged — get_active_challenges is ALREADY revoked in prod. Verified
-- 2026-08-22 with has_function_privilege (not the acl text): anon EXECUTE false,
-- authenticated EXECUTE false, service_role EXECUTE true. The challenges route and
-- the concierge tool both reach it server-side.
-- ⚠ Deliberately a MARKER and not a REVOKE: this is a byte-identical snapshot, and
-- CREATE OR REPLACE FUNCTION does NOT reset a function's ACL, so a REVOKE here would
-- CHANGE production while presenting itself as a no-op.
--
-- REVERT: none needed — a no-op capture of what prod already runs.

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
      'packsPerUser', ROUND(c.total_reward_allocation::numeric / NULLIF(c.completed_count, 0), 2),
      'totalRequired', COALESCE(t.total_slots, 0),
      'ownedCount', COALESCE(a.filled_slots, 0),
      'missingCount', COALESCE(t.total_slots,0) - COALESCE(a.filled_slots,0),
      'unresolvedSlots', COALESCE(t.total_slots,0) - COALESCE(a.resolved_slots,0),
      'completionPct', ROUND(100.0 * COALESCE(a.filled_slots,0)::numeric / NULLIF(t.total_slots,0), 1),
      'costToComplete', a.cost_to_complete, 'entryFloor', c.cached_entry_floor,
      'rewardValue', c.cached_reward_value,
      'netEv', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                    ELSE ROUND(c.cached_reward_value * GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) - a.cost_to_complete, 2) END,
      'worthIt', CASE WHEN c.cached_reward_value IS NULL OR a.cost_to_complete IS NULL THEN NULL
                      ELSE (c.cached_reward_value * GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) - a.cost_to_complete) > 0 END)
      ORDER BY (c.cached_reward_value * GREATEST(COALESCE(c.total_reward_allocation::numeric / NULLIF(c.completed_count,0), 1), 1) - a.cost_to_complete) DESC NULLS LAST, c.ends_at ASC NULLS LAST)
    FROM ch c LEFT JOIN totals t ON t.challenge_id = c.id LEFT JOIN agg a ON a.challenge_id = c.id), '[]'::jsonb)
)
$function$;
