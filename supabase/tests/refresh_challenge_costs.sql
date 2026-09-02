-- DB invariant: public.refresh_challenge_costs(uuid) -- the challenge cost/reward
-- WRITER (lib/challenges) that fills the cached_* columns the challenge READS
-- (get_active_challenges / get_challenge_plan) serve. Pinned: cost aggregation
-- (cached_cost_to_complete = SUM of per-slot min cost; cached_entry_floor = MIN;
-- cost_refreshed_at stamped), the reward-value ladder (pack ->
-- pack_ev_latest.gross_ev first, else secondary-sale median; moment -> catalog
-- fmv; other -> NULL), and the returned refreshed-challenge count.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260902120329_audit_20260902_challenge_costs_arm1_hoisted_out_of_the_per_row_loop.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- REPOINTED 2026-09-02: the pin had named the 2026-08-01 snapshot, and that day's
-- perf fix (the pack-EV lookup hoisted out of the per-row loop into the _pack_ev
-- TEMP table) redefined the function without moving the pin -- so db-pin-staleness
-- went red, correctly, and this is the repair rather than a behaviour change.
-- Verified against LIVE prod 2026-09-02, expression recorded beside the digest so
-- it stays checkable: md5(pg_get_functiondef(oid)) = c39522c974490a3071f8813d31bf803b.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE challenges (id uuid, collection_id uuid, reward_kind text, reward_pack_dist_id text, reward_moment_external_id text, cached_cost_to_complete numeric, cached_entry_floor numeric, cost_refreshed_at timestamptz, cached_reward_value numeric);
CREATE TABLE badge_editions (external_id text, collection_id uuid, low_ask numeric);
CREATE TABLE challenge_slot_editions (challenge_id uuid, slot_order int, external_id text);
CREATE TABLE mv_topshot_set_play_catalog (external_id text, fmv_usd numeric);
CREATE TABLE pack_ev_latest (dist_id text, collection_id uuid, gross_ev numeric, snapshotted_at timestamptz);
CREATE TABLE pack_purchases (pack_dist_id text, event_kind text, sale_price numeric, sealed_at timestamptz);
CREATE TABLE pack_drop_pool (dist_id text, edition_id uuid, drop_weight numeric);
CREATE TABLE fmv_snapshots (edition_id uuid, fmv_usd numeric, computed_at timestamptz);

-- >>> BEGIN verbatim refresh_challenge_costs (keep byte-identical to the migration) >>>
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
-- <<< END verbatim refresh_challenge_costs <<<

-- CH1 pack/d1: 2 slots (ekA 30, ekB 40) -> cost 70, entry_floor 30; reward via pack_ev_latest 250.
-- CH2 moment/ekM: reward = catalog fmv 88. CH3 badge: reward NULL.
-- CH4 pack/d4: no pack_ev_latest -> secondary-sale median of {100,200,300} = 200.
INSERT INTO challenges (id, collection_id, reward_kind, reward_pack_dist_id, reward_moment_external_id) VALUES
  ('00000000-0000-0000-0000-0000000c0001','00000000-0000-0000-0000-00000000cccc','pack',  'd1', NULL),
  ('00000000-0000-0000-0000-0000000c0002','00000000-0000-0000-0000-00000000cccc','moment', NULL,'ekM'),
  ('00000000-0000-0000-0000-0000000c0003','00000000-0000-0000-0000-00000000cccc','badge',  NULL, NULL),
  ('00000000-0000-0000-0000-0000000c0004','00000000-0000-0000-0000-00000000cccc','pack',  'd4', NULL);
INSERT INTO badge_editions (external_id, collection_id, low_ask) VALUES ('ekA','00000000-0000-0000-0000-00000000cccc',30),('ekB','00000000-0000-0000-0000-00000000cccc',40);
INSERT INTO challenge_slot_editions (challenge_id, slot_order, external_id) VALUES ('00000000-0000-0000-0000-0000000c0001',1,'ekA'),('00000000-0000-0000-0000-0000000c0001',2,'ekB');
INSERT INTO mv_topshot_set_play_catalog (external_id, fmv_usd) VALUES ('ekM',88);
-- TWO rows for d1 on purpose. The 2026-09-02 hoist reads this view through
-- `SELECT DISTINCT ON (dist_id) ... ORDER BY dist_id, snapshotted_at DESC`, so a
-- single row would satisfy the assertion below no matter which row the ordering
-- picked -- i.e. it could not tell a working ORDER BY from a dropped one. The
-- stale row carries a DIFFERENT gross_ev (999), so 'CH1 reward = 250' now also
-- proves the LATEST snapshot wins.
INSERT INTO pack_ev_latest (dist_id, collection_id, gross_ev, snapshotted_at) VALUES
  ('d1','00000000-0000-0000-0000-00000000cccc',999, now() - interval '2 days'),
  ('d1','00000000-0000-0000-0000-00000000cccc',250, now());
INSERT INTO pack_purchases (pack_dist_id, event_kind, sale_price, sealed_at) VALUES
  ('d4','secondary_sale',100, now()-interval '1 day'),
  ('d4','secondary_sale',200, now()-interval '2 day'),
  ('d4','secondary_sale',300, now()-interval '3 day');

-- Single writer call; it returns the count of challenges whose reward value was refreshed.
SELECT _assert_eq(refresh_challenge_costs('00000000-0000-0000-0000-00000000cccc'::uuid)::text, '4', 'refreshes all 4 challenges in the collection');

-- CH1 cost aggregation.
SELECT _assert((SELECT cached_cost_to_complete FROM challenges WHERE id='00000000-0000-0000-0000-0000000c0001') = 70, 'CH1 cost-to-complete = SUM(slot mins) = 30+40');
SELECT _assert((SELECT cached_entry_floor FROM challenges WHERE id='00000000-0000-0000-0000-0000000c0001') = 30, 'CH1 entry_floor = MIN(slot cost) = 30');
SELECT _assert_eq((SELECT (cost_refreshed_at IS NOT NULL)::text FROM challenges WHERE id='00000000-0000-0000-0000-0000000c0001'), 'true', 'cost_refreshed_at stamped');
-- Reward-value ladder.
SELECT _assert((SELECT cached_reward_value FROM challenges WHERE id='00000000-0000-0000-0000-0000000c0001') = 250, 'CH1 reward = pack_ev_latest.gross_ev (top of the ladder)');
SELECT _assert((SELECT cached_reward_value FROM challenges WHERE id='00000000-0000-0000-0000-0000000c0002') = 88, 'CH2 reward = moment catalog fmv');
SELECT _assert_eq((SELECT (cached_reward_value IS NULL)::text FROM challenges WHERE id='00000000-0000-0000-0000-0000000c0003'), 'true', 'CH3 non-pack/non-moment reward = NULL');
SELECT _assert((SELECT cached_reward_value FROM challenges WHERE id='00000000-0000-0000-0000-0000000c0004') = 200, 'CH4 reward = secondary-sale median fallback (median of 100/200/300)');

SELECT '✓ refresh_challenge_costs invariants pass' AS result;
ROLLBACK;
