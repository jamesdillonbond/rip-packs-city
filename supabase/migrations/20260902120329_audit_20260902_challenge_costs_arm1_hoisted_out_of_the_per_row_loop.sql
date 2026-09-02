-- 2026-09-02 — `refresh_challenge_costs` spent 99.7% of its budget on a lookup that
-- cannot match, and died at the 120 s wall on 8 of its last 52 daily runs.
--
-- ── THE SYMPTOM ────────────────────────────────────────────────────────────────
-- pg_cron jobid 87 `rpc-refresh-challenge-costs` (`20 7 * * *`, owner `postgres`)
-- fails at **exactly 120.0 s** with `canceling statement due to statement timeout`,
-- on 8 of 52 recorded runs (15.4%): 08-14, 08-15, 08-18, 08-21, 08-23, 08-24,
-- 08-26, 09-02. Successful runs take 30–120 s. The wall is the CLUSTER DEFAULT
-- (`statement_timeout = 120000`), which is what a `postgres`-owned pg_cron job runs
-- under — the function's own `SET statement_timeout TO '120s'` is inert on that path
-- (known-issues #43) and happens to name the same number.
--
-- ⚠ NOTHING WATCHED IT. The function writes no `pipeline_runs` row, so the only
-- witness was `cron.job_run_details`. Both UPDATEs are inside one
-- `SELECT refresh_challenge_costs()`, so a timeout in the second rolls back the
-- first: on those 8 days NOTHING was refreshed and `challenges.cached_*` silently
-- aged another day.
--
-- ── WHERE THE TIME WENT (EXPLAIN ANALYZE, BUFFERS, 2026-09-02, warm) ───────────
--   UPDATE 1 (cost_to_complete / entry_floor)      98 ms /       1,447 buffers
--   UPDATE 2 arm 1  pack_ev_latest              40,716 ms /  21,094,324 buffers
--   UPDATE 2 arm 2  pack_purchases median          266 ms /         988 buffers
--   UPDATE 2 arm 3  pack_drop_pool × fmv           785 ms /      22,437 buffers
--   UPDATE 2 arm 4  (never reached — arm 3 answers)
--
-- **Arm 1 is 99.7% of the buffers.** `pack_ev_latest` is a VIEW with
-- `DISTINCT ON (pack_listing_id) … ORDER BY pack_listing_id, snapshotted_at DESC`,
-- so a correlated scalar subquery against it cannot push `dist_id` through the
-- DISTINCT — Postgres re-materialises the WHOLE view once PER CHALLENGE ROW: 31
-- loops × 302,962 rows scanned, and the view's own `pack_ask_state` NOT EXISTS
-- subplan runs **3,849,487 times** for 11.4M buffers of that total.
--
-- ── AND IT CANNOT EVER PRODUCE A VALUE HERE ───────────────────────────────────
-- Measured, not assumed: **`rows=0` on all 31 loops.** Of the 29 distinct
-- `challenges.reward_pack_dist_id`, **29 exist in `pack_distributions` and ZERO have
-- any row in `pack_ev_history`** — so this is not the view's filters excluding them
-- and not a vocabulary mismatch (both are numeric-string dist ids in the same range;
-- `max(pack_ev_history.dist_id) = 8643` vs `max(challenge dist) = 8571`). Challenge
-- reward packs are rewards, not listings, and `pack_ev_history` is keyed on
-- `pack_listing_id`. The COALESCE therefore always falls through to arm 3, which is
-- what actually produces every value.
--
-- ── THE FIX: HOIST, DO NOT DELETE ─────────────────────────────────────────────
-- The arm is computed ONCE into a temp table instead of once per challenge. New cost
-- **1,220 ms / 681,430 buffers** — 31× fewer buffers, 33× faster — bringing the whole
-- function to roughly 2.4 s against a 120 s wall.
--
-- ⛔ Deleting arm 1 was rejected. It is empty TODAY for a structural reason, but a
-- challenge reward pack that ever gets listed would populate it, and dropping the
-- preferred source to save a lookup that now costs 1.2 s is not a trade worth making.
-- The cost was never the arm; it was evaluating it 31 times.
--
-- ⚠ ONE DELIBERATE SEMANTIC CHANGE, STATED RATHER THAN HIDDEN. The old arm was
-- `… LIMIT 1` with NO `ORDER BY` — physical order, i.e. an arbitrary row when a
-- dist_id has several. The hoist picks `DISTINCT ON (dist_id) … ORDER BY dist_id,
-- snapshotted_at DESC`, i.e. the NEWEST. That is strictly better defined than what it
-- replaces, and on today's data it changes nothing, because the population it would
-- disambiguate is empty — which the post-state below PROVES rather than asserts.

-- anon-exec: unchanged-by-replace (refresh_challenge_costs) — this is a CREATE OR
-- REPLACE of an existing function, and REPLACE does not reset a function ACL. Verified
-- live before applying: acl is `postgres=X/postgres | service_role=X/postgres`, and
-- has_function_privilege reads anon=false, authenticated=false. Adding a REVOKE here
-- would be a no-op that pretends to be a change; adding a GRANT would widen it.

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

-- ── POST-STATE, AND A CONTROL THAT WAS WRONG ON THE FIRST ATTEMPT ─────────────
-- 🚨 The first version of this migration asserted that no `cached_reward_value`
-- CHANGED. It failed: **18 of 31 changed**, and the migration correctly rolled
-- itself back. The assertion was the bug, not the rewrite. The stored values were
-- computed by the last SUCCESSFUL cron run (a day or more ago, since this job fails
-- 15% of days); arms 2–4 read `pack_purchases` and `fmv_snapshots`, which move
-- daily. So that comparison measured DATA DRIFT ACROSS A REFRESH WINDOW and
-- reported it as a code difference — the same shape as this repo's rule that a
-- reading taken while its subject is changing is not a reading.
--
-- ⭐ The honest control is narrower and exact. Only ARM 1 changed, and the two forms
-- of arm 1 differ only where a challenge's reward dist appears in `pack_ev_latest`:
--   old: SELECT gross_ev FROM pack_ev_latest WHERE dist_id = … AND collection_id = … LIMIT 1
--   new: the same predicate, evaluated once into _pack_ev, then looked up
-- With ZERO matching rows both are NULL for every challenge, whatever the tie-break.
-- So `overlap = 0` IS the equivalence proof, and it costs 1.2 s instead of the 40 s
-- an old-vs-new value A/B would have needed. It is asserted, not assumed.
DO $mig$
DECLARE
  v_overlap integer;
  v_n       integer;
BEGIN
  SELECT count(*) INTO v_overlap
  FROM public.pack_ev_latest pe
  JOIN public.challenges c
    ON c.reward_pack_dist_id = pe.dist_id AND c.collection_id = pe.collection_id
  WHERE c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';

  IF v_overlap <> 0 THEN
    RAISE EXCEPTION
      'arm 1 now matches % challenge row(s) in pack_ev_latest. The measurement this migration rests on (zero overlap) no longer holds, so the LIMIT 1 -> newest-snapshot tie-break could change a published value. Review before applying.',
      v_overlap;
  END IF;

  -- It must actually RUN, or "0 values changed" would be true for the wrong reason.
  v_n := public.refresh_challenge_costs();
  IF v_n IS NULL OR v_n = 0 THEN
    RAISE EXCEPTION 'refresh_challenge_costs() reported % updated rows — it did not run', v_n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.challenges
    WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND cost_refreshed_at > now() - interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'no challenge row carries a fresh cost_refreshed_at — the first UPDATE did not land';
  END IF;

  RAISE NOTICE 'refresh_challenge_costs rewritten: % rows refreshed, arm-1 overlap %', v_n, v_overlap;
END
$mig$;
