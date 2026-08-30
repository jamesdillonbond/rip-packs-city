-- DB invariant: public.compute_pack_ev_per_edition_weighted — the pack-EV pricing
-- core. It computes a pack's per-slot ACTUAL EV as the drop_weight-weighted MEAN
-- of its editions' FMVs, the TYPICAL PULL as the drop_weight-weighted MEDIAN, and
-- REFUSES to price a Top Shot pack whose remaining pool has collapsed to a single
-- drop_weight or drained below half a slot (the chase-bias guards that stopped
-- $0/fabricated EVs).
--
-- REPINNED 2026-07-31. This test previously embedded the 2026-07-07 copy, which
-- production had moved ~2 weeks past (live since schema_migrations 20260717193153,
-- with 4 intervening redefinitions, NONE committed as migration files). Three
-- behaviours had no pinned invariant at all:
--
--   * typical_pull_ev / typical_per_slot — the weighted MEDIAN. This is the number
--     the public pack-EV surfaces LEAD with (Typical Pull, not Actual EV), and it
--     was entirely absent from the pinned copy.
--   * pool_incomplete — a Top Shot pool whose remaining drop_weight sums below 0.5
--     is refused rather than priced off a sliver.
--   * Top Shot ALWAYS prices off the remaining pool. The pinned copy let any
--     collection opt into the original mint-time pool when orig_drop_weight was
--     present; live, `v_use_original` is forced false for Top Shot, so a TS pool
--     carrying orig weights now prices off drop_weight. D5 below pins that, and it
--     is the assertion the stale copy got backwards.
--
-- Neither drift was detectable from the repo alone (one committed migration
-- defines this function; the rewrites were MCP-applied). See
-- supabase/migrations/20260731210000_audit_20260731_snapshot_stale_pin_ddl_fmv_clamp_and_pack_ev.sql.
--
-- REPINNED AGAIN 2026-08-02. fmv_coverage_pct and edition_count were counted over
-- EVERY pack_drop_pool row for the distribution, including rows exhausted to zero
-- weight, so both described a pool that can no longer be pulled. `edition_count` is
-- persisted to pack_ev_latest.edition_count and published; live TS distributions were
-- overstating the pullable pool by up to 27x (dist 5736: 1,014 claimed vs 37 pullable).
-- The counts are now taken over weight > 0 under the basis actually in use. The change
-- is EV-neutral by construction -- a zero-weight row contributes 0 to both sides of
-- every weighted aggregate -- and D9 below pins exactly that. See
-- supabase/migrations/20260802210000_audit_20260802_pack_ev_coverage_denominator_pullable_only.sql.
--
-- REPINNED 2026-08-30: the pool's FMV lookup is a per-edition LATERAL on
-- fmv_snapshots instead of a join to the fmv_current view (1.26M buffers per
-- call -> 530). See supabase/migrations/20260830152806_audit_20260830_pack_ev_pool_reads_latest_snapshot_per_edition_not_the_fmv_current_view.sql.
--
-- DDL below is a VERBATIM copy of that migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Since 2026-08-30 the function reads fmv_snapshots directly (newest row per
-- pool edition, then the collection must match); a plain table stands in.
CREATE TABLE pack_drop_pool (
  collection_id uuid, dist_id text, edition_id uuid,
  drop_weight numeric, orig_drop_weight numeric);
CREATE TABLE fmv_snapshots (edition_id uuid, collection_id uuid, fmv_usd numeric, computed_at timestamptz);

-- >>> BEGIN verbatim compute_pack_ev_per_edition_weighted (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.compute_pack_ev_per_edition_weighted(p_collection_id uuid, p_dist_id text, p_pack_price numeric, p_slots integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool_rows_total         int;
  v_edition_count           int;
  v_editions_with_fmv       int;
  v_per_slot_ev             numeric;
  v_typical_per_slot        numeric;
  v_total_weight            numeric;
  v_covered_weight          numeric;
  v_weighted_coverage_pct   smallint;
  v_unweighted_coverage_pct smallint;
  v_gross_ev                numeric;
  v_typical_pull_ev         numeric;
  v_pack_ev                 numeric;
  v_value_ratio             numeric;
  v_use_original            boolean;
  v_basis                   text;
  v_live_rows               int;
  v_live_distinct_weights   int;
  v_is_topshot              boolean;
  v_sum_dw                  numeric;
BEGIN
  v_is_topshot := (p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid);

  IF v_is_topshot THEN
    SELECT count(*), count(DISTINCT drop_weight), COALESCE(sum(drop_weight),0)
      INTO v_live_rows, v_live_distinct_weights, v_sum_dw
    FROM pack_drop_pool
    WHERE collection_id = p_collection_id AND dist_id = p_dist_id AND drop_weight > 0;
    IF v_live_rows = 0 OR (v_live_rows > 1 AND v_live_distinct_weights <= 1) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_varied_remaining_pool', 'dist_id', p_dist_id);
    END IF;
    IF v_sum_dw < 0.5 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'pool_incomplete', 'dist_id', p_dist_id,
                                'sum_drop_weight', round(v_sum_dw, 4));
    END IF;
  END IF;

  IF v_is_topshot THEN
    v_use_original := false;
  ELSE
    SELECT bool_or(orig_drop_weight IS NOT NULL) INTO v_use_original
    FROM pack_drop_pool
    WHERE collection_id = p_collection_id AND dist_id = p_dist_id;
    v_use_original := COALESCE(v_use_original, false);
  END IF;
  v_basis := CASE WHEN v_use_original THEN 'original' ELSE 'remaining' END;

  -- v_edition_count counts only PULLABLE editions (weight > 0 under the basis actually
  -- in use). It is the denominator of fmv_coverage_pct, so counting editions that have
  -- been exhausted to zero weight published a coverage figure diluted by editions that
  -- can no longer come out of the pack. v_pool_rows_total keeps the original unfiltered
  -- count so the pool_empty guard behaves exactly as before.
  -- EV-NEUTRAL BY CONSTRUCTION: a zero-weight row contributes 0 to both the numerator
  -- and the denominator of every weighted aggregate below, so gross_ev, typical_pull_ev,
  -- pack_ev, value_ratio, total_pool_weight, covered_pool_weight and
  -- weighted_fmv_coverage_pct are all unchanged. Only the COUNT-based fields move.
  SELECT count(*),
         count(*) FILTER (WHERE (CASE WHEN v_use_original THEN COALESCE(orig_drop_weight, 0) ELSE drop_weight END) > 0),
         COALESCE(sum(CASE WHEN v_use_original THEN COALESCE(orig_drop_weight, 0) ELSE drop_weight END), 0)
    INTO v_pool_rows_total, v_edition_count, v_total_weight
  FROM pack_drop_pool pdp
  WHERE pdp.collection_id = p_collection_id AND pdp.dist_id = p_dist_id;

  IF v_pool_rows_total = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_empty', 'dist_id', p_dist_id);
  END IF;
  IF v_total_weight = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'zero_total_weight', 'dist_id', p_dist_id);
  END IF;

  -- Mean + coverage over covered pool; weighted MEDIAN moment value for the typical pull.
  WITH pool AS (
    SELECT
      CASE WHEN v_use_original THEN COALESCE(pdp.orig_drop_weight, 0) ELSE pdp.drop_weight END AS w,
      fc.fmv_usd
    FROM pack_drop_pool pdp
    -- 2026-08-30: the latest snapshot per pool edition, looked up per row.
    -- This was `LEFT JOIN fmv_current` -- the DISTINCT ON view -- and the
    -- planner cannot push a join key into DISTINCT ON, so every call walked
    -- all 1.31M fmv_snapshots rows to price a 40-80 row pool: 1,259,494
    -- buffers / 17.2 s vs 530 buffers / 6 ms for the identical rows (dist
    -- 1246). Same semantics as the view: newest snapshot for the edition
    -- regardless of collection, then the collection must match or the row
    -- is unpriced.
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd, s.collection_id
      FROM fmv_snapshots s
      WHERE s.edition_id = pdp.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fc ON fc.collection_id = pdp.collection_id
    WHERE pdp.collection_id = p_collection_id
      AND pdp.dist_id = p_dist_id
  ),
  agg AS (
    SELECT
      sum(w * fmv_usd) FILTER (WHERE fmv_usd IS NOT NULL)
        / NULLIF(sum(w) FILTER (WHERE fmv_usd IS NOT NULL), 0) AS mean_ev,
      count(*) FILTER (WHERE fmv_usd IS NOT NULL AND w > 0) AS n_fmv,
      sum(w) FILTER (WHERE fmv_usd IS NOT NULL) AS cov_w
    FROM pool
  ),
  cum AS (
    SELECT fmv_usd,
           sum(w) OVER (ORDER BY fmv_usd) AS cw,
           sum(w) OVER () AS tw
    FROM pool WHERE fmv_usd IS NOT NULL AND w > 0
  ),
  med AS (
    SELECT min(fmv_usd) AS median_ev FROM cum WHERE cw >= 0.5 * tw
  )
  SELECT agg.mean_ev, agg.n_fmv, agg.cov_w, med.median_ev
  INTO v_per_slot_ev, v_editions_with_fmv, v_covered_weight, v_typical_per_slot
  FROM agg CROSS JOIN med;

  IF v_editions_with_fmv = 0 OR v_per_slot_ev IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_fmv_coverage', 'dist_id', p_dist_id);
  END IF;

  v_weighted_coverage_pct   := (100.0 * v_covered_weight / v_total_weight)::smallint;
  v_unweighted_coverage_pct := (100.0 * v_editions_with_fmv / v_edition_count)::smallint;

  v_gross_ev := round((v_per_slot_ev * GREATEST(p_slots, 1))::numeric, 2);
  v_typical_pull_ev := round((COALESCE(v_typical_per_slot, 0) * GREATEST(p_slots, 1))::numeric, 2);
  v_pack_ev  := round((v_gross_ev - COALESCE(p_pack_price, 0))::numeric, 2);
  v_value_ratio := CASE WHEN p_pack_price > 0
    THEN round((v_gross_ev / p_pack_price)::numeric, 3)
    ELSE NULL END;

  v_pack_ev  := GREATEST(LEAST(v_pack_ev, 1000000), -10000);
  v_gross_ev := GREATEST(LEAST(v_gross_ev, 1000000), -10000);
  v_typical_pull_ev := GREATEST(LEAST(v_typical_pull_ev, 1000000), 0);

  RETURN jsonb_build_object(
    'ok', true,
    'gross_ev', v_gross_ev,
    'typical_pull_ev', v_typical_pull_ev,
    'typical_per_slot', round(COALESCE(v_typical_per_slot,0),2),
    'pack_ev', v_pack_ev,
    'value_ratio', v_value_ratio,
    'is_positive_ev', v_pack_ev > 0,
    'edition_count', v_edition_count,
    'pool_rows_total', v_pool_rows_total,
    'editions_with_fmv', v_editions_with_fmv,
    'fmv_coverage_pct', v_unweighted_coverage_pct,
    'weighted_fmv_coverage_pct', v_weighted_coverage_pct,
    'per_edition_weighted', true,
    'ev_basis', v_basis,
    'total_pool_weight', round(v_total_weight, 4),
    'covered_pool_weight', round(v_covered_weight, 4)
  );
END;
$function$;
-- <<< END verbatim compute_pack_ev_per_edition_weighted <<<

-- Constants
--   TS   = the Top Shot collection (the only one the chase-bias guards apply to)
--   OTHER= any non-TS collection (guards do not apply; original basis still can)
DO $seed$
DECLARE
  ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  other uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  eA uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  eB uuid := 'aaaaaaaa-0000-0000-0000-000000000002';
  eC uuid := 'aaaaaaaa-0000-0000-0000-000000000003';
  eD uuid := 'aaaaaaaa-0000-0000-0000-000000000004';
  eE uuid := 'aaaaaaaa-0000-0000-0000-000000000005';
  eF uuid := 'aaaaaaaa-0000-0000-0000-000000000006';
BEGIN
  -- Snapshots: the function takes each edition's NEWEST row, then requires
  -- its collection to match the pool's. eA=$10 and eB=$100 on TS (eA also has
  -- an OLDER $999 row that must never win); eD=$10, eE=$20 on OTHER; eC has no
  -- snapshot anywhere; eF's newest snapshot belongs to OTHER, so it is
  -- unpriced in a TS pool.
  INSERT INTO fmv_snapshots VALUES
    (eA,ts,999,now()-interval '2 days'),(eA,ts,10,now()-interval '1 hour'),
    (eB,ts,100,now()-interval '1 hour'),
    (eD,other,10,now()-interval '1 hour'),(eE,other,20,now()-interval '1 hour'),
    (eF,ts,500,now()-interval '2 days'),(eF,other,7,now()-interval '1 hour');

  -- D1 (TS): varied weights 0.9/0.1/0.5; A+B priced, C unpriced.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight, orig_drop_weight) VALUES
    (ts,'D1',eA,0.9,NULL),(ts,'D1',eB,0.1,NULL),(ts,'D1',eC,0.5,NULL);

  -- D2 (TS): 2+ rows sharing ONE weight → chase-bias guard must refuse.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (ts,'D2',eA,0.5),(ts,'D2',eB,0.5);

  -- D3 (OTHER): uniform weight → guard does NOT apply, so it still prices.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (other,'D3',eD,0.5),(other,'D3',eE,0.5);

  -- D4 (TS): varied weights but NO FMV coverage (eC only, which has no FMV row).
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (ts,'D4',eC,0.9),(ts,'D4',eC,0.1);

  -- D5 (TS) carries orig weights 0.8/0.2 — live TS ignores them and prices off
  -- drop_weight 0.2/0.8. Mean and median diverge here (82 vs 100), which is what
  -- makes it a real test of the two statistics rather than one number twice.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight, orig_drop_weight) VALUES
    (ts,'D5',eA,0.2,0.8),(ts,'D5',eB,0.8,0.2);

  -- D6 (OTHER): same shape as D5 on a non-TS collection → original basis DOES apply.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight, orig_drop_weight) VALUES
    (other,'D6',eD,0.2,0.8),(other,'D6',eE,0.8,0.2);

  -- D10 (TS): eA priced $10 (its $999 row is older) and eF, whose NEWEST
  -- snapshot is OTHER's, so eF is unpriced here. Pins the two lookup steps.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (ts,'D10',eA,0.7),(ts,'D10',eF,0.3);

  -- D7 (TS): weights vary, but the remaining pool has drained to 0.4 of a slot.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (ts,'D7',eA,0.3),(ts,'D7',eB,0.1);

  -- D8 (TS): a genuinely single-edition pool. One row cannot be "collapsed to one
  -- weight", so the varied-pool guard must NOT fire (v_live_rows > 1 is required).
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight) VALUES
    (ts,'D8',eA,1.0);

  -- D9 (TS): identical to D1's PULLABLE rows (eA 0.9, eB 0.1, eC 0.5) plus two
  -- EXHAUSTED rows at drop_weight 0. Exhausted editions cannot come out of the pack,
  -- so they must not appear in edition_count / editions_with_fmv / fmv_coverage_pct,
  -- and -- because they carry zero weight -- they must not move any EV statistic.
  -- D9 must therefore match D1 field for field, with pool_rows_total exposing the 5.
  INSERT INTO pack_drop_pool (collection_id, dist_id, edition_id, drop_weight, orig_drop_weight) VALUES
    (ts,'D9',eA,0.9,NULL),(ts,'D9',eB,0.1,NULL),(ts,'D9',eC,0.5,NULL),
    (ts,'D9',eA,0,NULL),(ts,'D9',eB,0,NULL);
END $seed$;

-- ── happy path: mean = (0.9*10 + 0.1*100)/1.0 = 19; median = 10 ──────────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'ok'),
  'true', 'D1 prices ok');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'gross_ev'),
  '19.00', 'D1 per-slot weighted MEAN (Actual EV) = 19');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'typical_pull_ev'),
  '10.00', 'D1 weighted MEDIAN (Typical Pull) = 10 — below the mean, as a chase pool should be');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'typical_per_slot'),
  '10.00', 'D1 typical_per_slot is the per-slot median');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'pack_ev'),
  '9.00', 'D1 pack_ev = 19 - 10');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'value_ratio'),
  '1.900', 'D1 value_ratio = 19/10');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'is_positive_ev'),
  'true', 'D1 is +EV');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'edition_count'),
  '3', 'D1 counts all 3 editions -- every D1 row is pullable');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'editions_with_fmv'),
  '2', 'D1 has FMV for 2 of 3');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'weighted_fmv_coverage_pct'),
  '67', 'D1 weighted coverage = 1.0 of 1.5');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,1)->>'ev_basis'),
  'remaining', 'D1 uses the remaining pool');

-- ── exhausted (zero-weight) editions are excluded from the published counts ──
-- D9 = D1's pullable rows + 2 rows drained to drop_weight 0.
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D9',10,1)->>'edition_count'),
  '3', 'D9 edition_count counts only the 3 PULLABLE editions, not the 5 pool rows');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D9',10,1)->>'pool_rows_total'),
  '5', 'D9 pool_rows_total still reports every pool row, exhausted included');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D9',10,1)->>'editions_with_fmv'),
  '2', 'D9 editions_with_fmv ignores the exhausted priced rows');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D9',10,1)->>'fmv_coverage_pct'),
  '67', 'D9 coverage = 2/3 pullable (67%), NOT the 4/5 (80%) the old diluted count gave');
-- and the exhausted rows move NO pricing field: D9 must equal D1 exactly.
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D9',10,1)->>'gross_ev'),
  '19.00', 'D9 Actual EV is unchanged by exhausted rows');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D9',10,1)->>'typical_pull_ev'),
  '10.00', 'D9 Typical Pull is unchanged by exhausted rows');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D9',10,1)->>'weighted_fmv_coverage_pct'),
  '67', 'D9 weighted coverage is unchanged (zero-weight rows carry no weight)');

-- slots multiplier scales BOTH statistics
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,2)->>'gross_ev'),
  '38.00', 'D1 with 2 slots doubles Actual EV');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D1',10,2)->>'typical_pull_ev'),
  '20.00', 'D1 with 2 slots doubles Typical Pull');

-- ── chase-bias guard: TS pool collapsed to one weight is refused ─────────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D2',10,1)->>'ok'),
  'false', 'D2 collapsed-weight TS pool is refused');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D2',10,1)->>'reason'),
  'no_varied_remaining_pool', 'D2 refusal reason');

-- a TS pool with a SINGLE row is not "collapsed" — it must still price
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D8',10,1)->>'ok'),
  'true', 'D8 single-edition TS pool is priced, not refused');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D8',10,1)->>'gross_ev'),
  '10.00', 'D8 single-edition pool prices at that edition FMV');

-- ── drained-pool guard: TS remaining weight under half a slot is refused ─────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D7',10,1)->>'reason'),
  'pool_incomplete', 'D7 TS pool summing to 0.4 of a slot is refused');
SELECT _assert((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D7',10,1)
                 ->>'sum_drop_weight')::numeric = 0.4,
  'D7 refusal reports the observed remaining weight');

-- ── the guards are TS-only: a non-TS uniform pool still prices ───────────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','D3',10,1)->>'ok'),
  'true', 'D3 non-TS uniform pool is NOT blocked');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','D3',10,1)->>'gross_ev'),
  '15.00', 'D3 mean = (0.5*10 + 0.5*20)/1.0 = 15');

-- ── no FMV coverage → refused ────────────────────────────────────────────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D4',10,1)->>'reason'),
  'no_fmv_coverage', 'D4 varied pool but no FMV → refused');

-- ── empty pool. Non-TS falls through to pool_empty; for TS the varied-pool
--    guard fires first, because zero live rows is its own refusal case. ────────
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','NOPE',10,1)->>'reason'),
  'pool_empty', 'unknown dist → pool_empty (non-TS, past the chase-bias guard)');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','NOPE',10,1)->>'reason'),
  'no_varied_remaining_pool', 'unknown TS dist is caught by the zero-live-rows arm');

-- ── basis selection: Top Shot ALWAYS uses the remaining pool ─────────────────
-- D5 carries orig 0.8/0.2 but drop 0.2/0.8. Live TS ignores orig entirely.
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D5',10,1)->>'ev_basis'),
  'remaining', 'D5 Top Shot ignores orig_drop_weight and prices off the remaining pool');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D5',10,1)->>'gross_ev'),
  '82.00', 'D5 mean uses drop weights: (0.2*10 + 0.8*100)/1.0 = 82');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D5',10,1)->>'typical_pull_ev'),
  '100.00', 'D5 median sits ABOVE the mean when weight concentrates on the dear edition');

-- ...but a non-TS collection with orig weights still uses the original basis
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','D6',10,1)->>'ev_basis'),
  'original', 'D6 non-TS pool with orig weights uses the original pool');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('dee28451-5d62-409e-a1ad-a83f763ac070','D6',10,1)->>'gross_ev'),
  '12.00', 'D6 original-weighted mean = (0.8*10 + 0.2*20)/1.0 = 12');

-- ── 2026-08-30: newest snapshot wins, and only if its collection matches ──
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D10',10,1)->>'gross_ev'),
  '10.00', 'D10 prices eA at its NEWEST snapshot ($10), never the older $999 row');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D10',10,1)->>'editions_with_fmv'),
  '1', 'D10: eF is unpriced because its newest snapshot belongs to another collection (its stale TS row does not count)');
SELECT _assert_eq((compute_pack_ev_per_edition_weighted('95f28a17-224a-4025-96ad-adf8a4c63bfd','D10',10,1)->>'weighted_fmv_coverage_pct'),
  '70', 'D10 weighted coverage = 0.7 of 1.0');

SELECT '✓ compute_pack_ev_per_edition_weighted invariants pass' AS result;
ROLLBACK;
