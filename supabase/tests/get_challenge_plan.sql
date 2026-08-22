-- DB invariant: public.get_challenge_plan(text,uuid) -- the per-challenge
-- DRILL-DOWN behind /topshot/challenge-plan. For a wallet + challenge it resolves
-- each slot: eligible editions + costs (badge floor low_ask / catalog fmv),
-- whether the wallet fills the slot, the cheapest-eligible 'pick' (the BUY
-- RECOMMENDATION with an /edition/ deep link), cost-to-complete over UNFILLED
-- slots, completion %, and the packs-per-user netEv/worthIt verdict. Pinned: the
-- non-expired gate, per-slot filled/eligibleCount, the cheapest-unowned cost, the
-- pick = cheapest eligible (even when the slot is already filled), an UNRESOLVED
-- slot (0 eligible -> null pick, counted, NULL cost ignored in the sum), the
-- filled/cheapest slot ORDER, and the totals/netEv math.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231100_audit_20260801_snapshot_get_challenge_plan.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (73cfdc158434860d1827db469e815699).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE challenges (id uuid, collection_id uuid, ends_at timestamptz, slug text, name text, challenge_type text, description text, status text, starts_at timestamptz, set_name text, total_reward_allocation int, completed_count int, reward_kind text, reward_label text, image_url text, cached_reward_value numeric);
CREATE TABLE badge_editions (external_id text, collection_id uuid, low_ask numeric, lock_rate_pct numeric, burn_rate_pct numeric);
CREATE TABLE wallet_moments_cache (wallet_address text, collection_id uuid, edition_key text);
CREATE TABLE challenge_slot_editions (challenge_id uuid, slot_order int, external_id text);
CREATE TABLE editions (external_id text, collection_id uuid, player_name text, tier text, thumbnail_url text);
CREATE TABLE mv_topshot_set_play_catalog (external_id text, fmv_usd numeric);
CREATE TABLE challenge_slots (challenge_id uuid, slot_order int, label text, play_category text, help_text text);

-- >>> BEGIN verbatim get_challenge_plan (keep byte-identical to the migration) >>>
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
-- <<< END verbatim get_challenge_plan <<<

-- CH1 non-expired: reward 100, alloc 10/completed 5 -> packsPerUser 2. 3 slots.
--   slot1: ekA1 (floor 50) + ekA2 (floor 30) eligible; wallet owns ekA1 -> filled.
--          cheapest-unowned = ekA2 (30); pick = ekA2 (cheapest of both).
--   slot2: ekB (floor 40) eligible, not owned -> filled=false, cost 40.
--   slot3: NO editions -> eligible_count 0 -> UNRESOLVED, pick null, NULL cost.
INSERT INTO challenges (id, collection_id, ends_at, slug, name, challenge_type, total_reward_allocation, completed_count, cached_reward_value) VALUES
  ('00000000-0000-0000-0000-0000000c0001','00000000-0000-0000-0000-00000000cccc', now()+interval '10 days','ch1','Challenge 1','set', 10, 5, 100);
INSERT INTO challenge_slots (challenge_id, slot_order, label) VALUES ('00000000-0000-0000-0000-0000000c0001',1,'Slot 1'),('00000000-0000-0000-0000-0000000c0001',2,'Slot 2'),('00000000-0000-0000-0000-0000000c0001',3,'Slot 3');
INSERT INTO challenge_slot_editions (challenge_id, slot_order, external_id) VALUES ('00000000-0000-0000-0000-0000000c0001',1,'ekA1'),('00000000-0000-0000-0000-0000000c0001',1,'ekA2'),('00000000-0000-0000-0000-0000000c0001',2,'ekB');
INSERT INTO editions (external_id, collection_id, player_name, tier, thumbnail_url) VALUES
  ('ekA1','00000000-0000-0000-0000-00000000cccc','PlayerA1','RARE','tA1'),('ekA2','00000000-0000-0000-0000-00000000cccc','PlayerA2','COMMON','tA2'),('ekB','00000000-0000-0000-0000-00000000cccc','PlayerB','RARE','tB');
INSERT INTO badge_editions (external_id, collection_id, low_ask, lock_rate_pct, burn_rate_pct) VALUES
  ('ekA1','00000000-0000-0000-0000-00000000cccc',50,10,5),('ekA2','00000000-0000-0000-0000-00000000cccc',30,20,8),('ekB','00000000-0000-0000-0000-00000000cccc',40,15,6);
INSERT INTO mv_topshot_set_play_catalog (external_id, fmv_usd) VALUES ('ekA1',45),('ekA2',35),('ekB',45);
INSERT INTO wallet_moments_cache (wallet_address, collection_id, edition_key) VALUES ('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc','ekA1');

-- Top-level totals.
SELECT _assert_eq((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'totalRequired'), '3', 'totalRequired = challenge_slots count');
SELECT _assert_eq((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'ownedCount'), '1', 'owns 1 slot (slot1 via ekA1)');
SELECT _assert_eq((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'missingCount'), '2', 'missing 2 slots');
SELECT _assert_eq((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'unresolvedSlots'), '1', 'slot3 has 0 eligible -> 1 unresolved');
SELECT _assert_eq((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'completionPct'), '33.3', '1 of 3 filled');
SELECT _assert((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'costToComplete')::numeric = 40, 'cost-to-complete = slot2 cheapest-unowned (40); slot3 NULL ignored');
SELECT _assert((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'netEv')::numeric = 160, 'netEv = 100 * packsPerUser 2 - cost 40 = 160');
SELECT _assert_eq((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'worthIt'), 'true', 'positive netEv -> worthIt');

-- ── WALLET MATCHING IS EXACT-OR-LOWERCASE, same rewrite as get_active_challenges ──
-- Re-pinned 2026-08-22. This function drifted in the SAME pass as its sibling: the
-- `owned` CTE moved from `lower(wmc.wallet_address) = lower(p_wallet)` to
-- `wmc.wallet_address IN (p_wallet, lower(p_wallet))`, which is sargable (a lower()
-- on the column cannot use an index) but NARROWER — a stored address whose case
-- differs from both the argument and its lowercase form no longer matches, so its
-- slots read as unowned and costToComplete reads as full price.
-- (The other -57 chars are a dropped comment on the `pick` CTE, not logic.)
--
-- ⚠ MEASURED 2026-08-22 and currently harmless: 384 mixed-case wallets in
-- wallet_moments_cache, none with a lowercase duplicate; 436 wallets own a challenge
-- slot edition all-time; the two sets are DISJOINT. See known-issues #24 — the first
-- reading of this looked like a live defect and was refuted by a positive control.
SELECT _assert_eq((get_challenge_plan('0xwallet00000001','00000000-0000-0000-0000-0000000c0001')->>'ownedCount'), '0',
  'a differently-cased form of the SAME stored wallet does NOT match — ownership is
   exact-or-lowercase, not case-insensitive');
SELECT _assert((get_challenge_plan('0xwallet00000001','00000000-0000-0000-0000-0000000c0001')->>'costToComplete')::numeric = 70,
  'and the miss shows up in the PRICE: every slot reads unowned, so cost-to-complete
   is the full 30+40 rather than 40');
SELECT _assert_eq((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'ownedCount'), '1',
  'while the exact stored form still matches — the control that keeps the two cases
   above from passing for the wrong reason');

-- Slots array + per-slot picks (look up by slotOrder, not position).
SELECT _assert_eq(jsonb_array_length(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots')::text, '3', '3 slot objects');
-- slot1 FILLED, eligibleCount 2, pick = cheapest eligible (ekA2, $30) even though slot is filled.
SELECT _assert_eq((SELECT e->>'filled' FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=1), 'true', 'slot1 filled');
SELECT _assert_eq((SELECT e->>'eligibleCount' FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=1), '2', 'slot1 has 2 eligible');
SELECT _assert_eq((SELECT e->'pick'->>'externalId' FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=1), 'ekA2', 'slot1 pick = the cheapest eligible (ekA2 $30)');
SELECT _assert_eq((SELECT e->'pick'->>'editionUrl' FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=1), '/nba-top-shot/edition/ekA2', 'pick carries the /edition/ deep link');
-- slot2 UNFILLED, pick = ekB.
SELECT _assert_eq((SELECT e->>'filled' FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=2), 'false', 'slot2 unfilled');
SELECT _assert_eq((SELECT e->'pick'->>'externalId' FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=2), 'ekB', 'slot2 pick = ekB');
-- slot3 UNRESOLVED: 0 eligible, pick is JSON null.
SELECT _assert_eq((SELECT e->>'eligibleCount' FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=3), '0', 'slot3 has 0 eligible');
SELECT _assert_eq((SELECT (e->'pick' = 'null'::jsonb)::text FROM jsonb_array_elements(get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->'slots') e WHERE (e->>'slotOrder')::int=3), 'true', 'unresolved slot has a null pick');

-- Expired challenge -> ch CTE empty -> function returns a row with null challengeId.
UPDATE challenges SET ends_at = now() - interval '1 day' WHERE id='00000000-0000-0000-0000-0000000c0001';
SELECT _assert((get_challenge_plan('0xWALLET00000001','00000000-0000-0000-0000-0000000c0001')->>'challengeId') IS NULL, 'an expired challenge yields no challenge object');

SELECT '✓ get_challenge_plan invariants pass' AS result;
ROLLBACK;
