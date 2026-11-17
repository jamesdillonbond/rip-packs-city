-- audit_20260924_price_recent_topshot_rips_rotates_past_its_head
--
-- price_recent_topshot_rips (20260924043605, pg_cron 599 every 10 min via
-- run_price_recent_topshot_rips) took the NEWEST 1,500 unpriced Top Shot rips of the last
-- 14 days (`ORDER BY sealed_at DESC LIMIT 1500`) and nothing rotated the set: a rip that
-- cannot be priced yet stays at the head every tick, and older rips that CAN be priced are
-- never reached. This is the "an ORDER BY on an immutable key re-reads its own head
-- forever" class (CLAUDE.md, #128). Measured 2026-09-24 ~8 AM PT by a read-only review:
-- the last 12 runs each had candidates=1500 and priced 0–29; still_null_14d flat at ~4,860;
-- 3,371 of the 4,871 unpriced rips sat outside the window, and on 800 of those the
-- function's own all-or-nothing rule priced 366 (all positive) — work the lane never did.
--
-- CHANGE (selection only; the pricing rule and the UPDATE are untouched): each tick takes
-- HALF its budget from the newest unpriced rips (fresh rips are still priced promptly) and
-- the other half as a RANDOM sample of the rest of the 14-day pool, so every unpriced rip is
-- visited within a few ticks without a new column or a cursor. The pool is ~5k rows, so the
-- random sort is trivial. Adds `head` / `sampled` to the returned jsonb.
-- Built from the LIVE pg_get_functiondef() by a guarded splice (RAISE unless each anchor
-- appears exactly once); CREATE OR REPLACE of the same signature keeps SECDEF, proconfig, ACL.
--
-- WATCH: pipeline_runs / job 599 output — still_null_14d should FALL over the next day
-- (it was flat at ~4,860). Falsifier: still flat after 24 h ⇒ the unpriced tail is genuinely
-- unpriceable and the head was not the constraint.
--
-- REVERT: re-apply the body from 20260924043605.
--
-- anon-exec: unchanged (price_recent_topshot_rips) — CREATE OR REPLACE of an existing fn keeps its ACL (proacl postgres + service_role only; verified 2026-09-24).

DO $mig$
DECLARE
  def text; anc text; n int;
BEGIN
  SELECT pg_get_functiondef('public.price_recent_topshot_rips(integer)'::regprocedure) INTO def;

  anc := E'  v_cand int := 0; v_priced int := 0; v_left int := 0;\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'declare anchor found % times, want 1', n; END IF;
  def := replace(def, anc, anc
    || E'  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 1500), 1), 5000);\n'
    || E'  v_head int := 0;\n');

  anc := E'  CREATE TEMP TABLE _prtr ON COMMIT DROP AS\n'
      || E'  SELECT pr.id, pr.collection_id, pr.moments_pulled\n'
      || E'    FROM public.pack_rips pr\n'
      || E'   WHERE pr.collection_id = v_ts\n'
      || E'     AND pr.sealed_at > now() - interval ''14 days''\n'
      || E'     AND pr.pull_value_usd IS NULL\n'
      || E'   ORDER BY pr.sealed_at DESC\n'
      || E'   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1500), 1), 5000);\n'
      || E'  GET DIAGNOSTICS v_cand = ROW_COUNT;\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'candidate anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
         E'  -- Half the budget from the HEAD (newest), half a RANDOM sample of the rest, so a\n'
      || E'  -- head that cannot be priced yet no longer starves the priceable tail (2026-09-24).\n'
      || E'  CREATE TEMP TABLE _prtr ON COMMIT DROP AS\n'
      || E'  SELECT pr.id, pr.collection_id, pr.moments_pulled\n'
      || E'    FROM public.pack_rips pr\n'
      || E'   WHERE pr.collection_id = v_ts\n'
      || E'     AND pr.sealed_at > now() - interval ''14 days''\n'
      || E'     AND pr.pull_value_usd IS NULL\n'
      || E'   ORDER BY pr.sealed_at DESC\n'
      || E'   LIMIT (v_lim + 1) / 2;\n'
      || E'  GET DIAGNOSTICS v_head = ROW_COUNT;\n'
      || E'  INSERT INTO _prtr (id, collection_id, moments_pulled)\n'
      || E'  SELECT pr.id, pr.collection_id, pr.moments_pulled\n'
      || E'    FROM public.pack_rips pr\n'
      || E'   WHERE pr.collection_id = v_ts\n'
      || E'     AND pr.sealed_at > now() - interval ''14 days''\n'
      || E'     AND pr.pull_value_usd IS NULL\n'
      || E'     AND NOT EXISTS (SELECT 1 FROM _prtr t WHERE t.id = pr.id)\n'
      || E'   ORDER BY random()\n'
      || E'   LIMIT v_lim / 2;\n'
      || E'  GET DIAGNOSTICS v_cand = ROW_COUNT;\n'
      || E'  v_cand := v_cand + v_head;\n');

  anc := E'RETURN jsonb_build_object(''candidates'', v_cand, ''priced'', v_priced, ''still_null_14d'', v_left);';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'return anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
    E'RETURN jsonb_build_object(''candidates'', v_cand, ''head'', v_head, ''sampled'', v_cand - v_head, ''priced'', v_priced, ''still_null_14d'', v_left);');

  EXECUTE def;
END
$mig$;
