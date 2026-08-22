-- DB invariant: public.get_active_challenges(text,uuid) -- backs the LIVE Top Shot
-- challenges tab + the concierge get_challenges tool. For each active, non-expired
-- challenge it computes per-slot cost (min of badge floor low_ask / catalog fmv),
-- wallet ownership, cost-to-complete (sum of UNOWNED slot costs), completion %,
-- and the packs-per-user-weighted netEv / worthIt verdict shown to users. Pinned:
-- the active + non-expired gate, per-slot MIN cost, wallet-scoped ownership (and
-- the wallet-NULL 'own nothing' path), cost-to-complete over UNOWNED slots, the
-- totals/completion math, and the netEv/worthIt formula.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231000_audit_20260801_snapshot_get_active_challenges.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (1bb18544686f8c61ef8d018101481c7d).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE challenges (id uuid, collection_id uuid, status text, ends_at timestamptz, slug text, name text, challenge_type text, image_url text, set_name text, reward_kind text, reward_label text, total_reward_allocation int, completed_count int, cached_entry_floor numeric, cached_reward_value numeric);
CREATE TABLE badge_editions (external_id text, collection_id uuid, low_ask numeric);
CREATE TABLE challenge_slot_editions (challenge_id uuid, slot_order int, external_id text);
CREATE TABLE challenge_slots (challenge_id uuid, slot_order int);
CREATE TABLE mv_topshot_set_play_catalog (external_id text, fmv_usd numeric);
CREATE TABLE wallet_moments_cache (edition_key text, collection_id uuid, wallet_address text);

-- >>> BEGIN verbatim get_active_challenges (keep byte-identical to the migration) >>>
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
-- <<< END verbatim get_active_challenges <<<

-- CH1 active: alloc 10 / completed 5 -> packsPerUser 2; reward_value 100. 2 slots.
--   slot1 edition ekA (floor 30, fmv 25 -> cost 30), slot2 ekB (floor 40, fmv 45 -> cost 40).
--   wallet W owns ekA (slot1) -> slot1 owned, slot2 not. cost_to_complete = 40.
-- CH2 status ended -> excluded. CH3 ends_at past -> excluded.
INSERT INTO challenges (id, collection_id, status, ends_at, slug, name, challenge_type, total_reward_allocation, completed_count, cached_entry_floor, cached_reward_value) VALUES
  ('00000000-0000-0000-0000-0000000c0001','00000000-0000-0000-0000-00000000cccc','active', now()+interval '10 days','ch1','Challenge 1','set', 10, 5, 50, 100),
  ('00000000-0000-0000-0000-0000000c0002','00000000-0000-0000-0000-00000000cccc','ended',  now()+interval '10 days','ch2','Challenge 2','set', 10, 5, 50, 100),
  ('00000000-0000-0000-0000-0000000c0003','00000000-0000-0000-0000-00000000cccc','active', now()-interval '1 day',  'ch3','Challenge 3','set', 10, 5, 50, 100);
INSERT INTO challenge_slots (challenge_id, slot_order) VALUES ('00000000-0000-0000-0000-0000000c0001',1),('00000000-0000-0000-0000-0000000c0001',2);
INSERT INTO challenge_slot_editions (challenge_id, slot_order, external_id) VALUES ('00000000-0000-0000-0000-0000000c0001',1,'ekA'),('00000000-0000-0000-0000-0000000c0001',2,'ekB');
INSERT INTO badge_editions (external_id, collection_id, low_ask) VALUES ('ekA','00000000-0000-0000-0000-00000000cccc',30),('ekB','00000000-0000-0000-0000-00000000cccc',40);
INSERT INTO mv_topshot_set_play_catalog (external_id, fmv_usd) VALUES ('ekA',25),('ekB',45);
INSERT INTO wallet_moments_cache (edition_key, collection_id, wallet_address) VALUES ('ekA','00000000-0000-0000-0000-00000000cccc','0xWALLET00000001');

-- WITH WALLET: only CH1 active; owns slot1, needs slot2 ($40).
SELECT _assert_eq((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->>'activeCount'), '1', 'only the active, non-expired challenge counts (ended + expired excluded)');
SELECT _assert_eq((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'totalRequired'), '2', 'totalRequired = challenge_slots count');
SELECT _assert_eq((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'ownedCount'), '1', 'wallet owns 1 slot (ekA)');
SELECT _assert_eq((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'missingCount'), '1', 'missing 1 slot');
SELECT _assert_eq((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'completionPct'), '50.0', '50% complete');
SELECT _assert((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'costToComplete')::numeric = 40, 'cost-to-complete = the one UNOWNED slot cost (min(floor40,fmv45)=40)');
SELECT _assert((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'packsPerUser')::numeric = 2, 'packsPerUser = alloc/completed = 2');
SELECT _assert((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'netEv')::numeric = 160, 'netEv = reward 100 * packsPerUser 2 - cost 40 = 160');
SELECT _assert_eq((get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'worthIt'), 'true', 'positive netEv -> worthIt true');

-- WITHOUT WALLET: owns nothing -> cost-to-complete = both slots (30+40=70), 0% complete.
SELECT _assert_eq((get_active_challenges(NULL,'00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'ownedCount'), '0', 'null wallet owns nothing');
SELECT _assert((get_active_challenges(NULL,'00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'costToComplete')::numeric = 70, 'null wallet cost-to-complete = both slot costs (30+40)');
SELECT _assert_eq((get_active_challenges(NULL,'00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'completionPct'), '0.0', 'null wallet 0% complete');

-- Empty collection -> activeCount 0, challenges [].
SELECT _assert_eq((get_active_challenges(NULL,'00000000-0000-0000-0000-00000000dddd')->>'activeCount'), '0', 'no challenges -> activeCount 0');
SELECT _assert_eq((get_active_challenges(NULL,'00000000-0000-0000-0000-00000000dddd')->'challenges')::text, '[]', 'no challenges -> [] not null');

-- ── WALLET MATCHING IS EXACT-OR-LOWERCASE, which is NARROWER than it was ──
-- Re-pinned 2026-08-22. The ONLY drift in this function was one line — the
-- ownership join moved from
--     lower(o.wallet_address) = lower(p_wallet)        -- any case matched
-- to
--     o.wallet_address IN (p_wallet, lower(p_wallet))  -- sargable, but narrower
-- The rewrite makes the predicate index-usable; wrapping the column in lower()
-- cannot use an index on wallet_address. It is ALSO a semantic narrowing: a stored
-- address whose case differs from BOTH the argument and its lowercase form no
-- longer matches, so its slots read as UNOWNED and costToComplete reads as full
-- price — on the "is this challenge worth it" verdict.
--
-- ⚠ MEASURED 2026-08-22, and currently HARMLESS: wallet_moments_cache holds 25,447
-- mixed-case rows across 384 wallets, NONE of which has a lowercase duplicate; 436
-- wallets own at least one challenge slot edition all-time; and the two sets are
-- DISJOINT. All 31 challenges are `ended` (latest 2026-07-16) besides.
-- ⚠ The first pass at this read as a live defect and was refuted only by a POSITIVE
-- CONTROL: "0 affected wallets" was vacuous because the active-challenge population
-- is empty. The 436 figure is the control that makes the zero mean something.
--
-- Pinned so the narrowing stops being silent: if ingest ever writes a mixed-case
-- address for a wallet that owns a slot, THIS is the line that decides.
SELECT _assert_eq(
  (get_active_challenges('0xwallet00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'ownedCount'),
  '0',
  'a differently-cased form of the SAME stored wallet does NOT match — ownership is
   exact-or-lowercase, not case-insensitive');
SELECT _assert_eq(
  (get_active_challenges('0xWALLET00000001','00000000-0000-0000-0000-00000000cccc')->'challenges'->0->>'ownedCount'),
  '1',
  'while the exact stored form still matches — the control that keeps the case above
   from passing for the wrong reason');

SELECT '✓ get_active_challenges invariants pass' AS result;
ROLLBACK;
