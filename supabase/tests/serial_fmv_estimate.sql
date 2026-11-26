-- DB invariant: public.serial_fmv_estimate (canonical 8-arg) — the Top Shot
-- special-serial FMV estimator. Given (collection, serial, circulation, tier,
-- edition_fmv, confidence, jersey_number, edition_id) it returns a jsonb estimate
-- resolving a strict engine precedence:  pooled_model → jersey power → power-law
-- → tier/circ grid → aggregate grid → NULL.  This is money math shown on the
-- moment/wallet/trophy/sniper surfaces, so a broken guard or a mis-ordered
-- fallthrough silently misprices every #1 / perfect / jersey-match serial.
--
-- Pins:
--   * the input guards (null/≤0 serial-circ-fmv, non-HIGH/MEDIUM confidence, and
--     a non-special serial) all return NULL;
--   * the pooled model fires ONLY when edition_id is passed, the model is active,
--     and set/player support ≥ gate_min_support — and stamps basis='pooled_model'
--     + the jersey1_match double-special flag;
--   * pooled beats the power-law which beats the grid (precedence);
--   * the grid tier_circ vs aggregate basis split;
--   * every estimate is floored at edition_fmv (never below the base FMV).
--   * (2026-11-25, serial-cal-1.0) serial_fmv_estimate is now a WRAPPER over the unchanged model
--     (renamed serial_fmv_estimate_uncalibrated): it divides the estimate by
--     serial_fmv_calibration.factor for the collection x bucket, keeps the edition_fmv floor,
--     stamps calibration_factor + uncalibrated_estimate_usd, and passes the model value through
--     untouched when there is no factor or the factor is 1. Every claim above runs through the
--     wrapper with no factor seeded, so it still pins the model itself.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261126013801_audit_20261125_serial_cal_and_pool_sync_reissue_for_pins.sql;
-- the wrapper first, then the model body; the model body is the 20260726015000 one, renamed);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures (only the columns the function reads) ────────────────────
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, set_id uuid, player_id uuid, jersey_number integer);

CREATE TABLE public.serial_fmv_pooled_model (
  collection_id uuid, is_active boolean, gate_min_support integer,
  fmv_min numeric, fmv_max numeric, intercept numeric,
  b_log_fmv numeric, b_log_circ numeric,
  tier_rare numeric, tier_legendary numeric, tier_fandom numeric,
  bucket_perfect numeric, px_rare numeric, px_legendary numeric, px_fandom numeric,
  prem_lo numeric, prem_hi numeric, jersey1 numeric, algo_version text);

CREATE TABLE public.serial_fmv_pooled_set_effect (
  collection_id uuid, set_id uuid, effect numeric, support_n integer);
CREATE TABLE public.serial_fmv_pooled_player_effect (
  collection_id uuid, player_id uuid, effect numeric, support_n integer);
CREATE TABLE public.serial_fmv_jersey_model (
  collection_id uuid, k numeric, beta numeric, r numeric,
  fmv_min numeric, fmv_max numeric, is_reliable boolean, tier text);
CREATE TABLE public.serial_fmv_power_model (
  collection_id uuid, k numeric, beta numeric, r numeric,
  fmv_min numeric, fmv_max numeric, is_reliable boolean, serial_bucket text, tier text);
CREATE TABLE public.serial_fmv_multipliers (
  collection_id uuid, multiplier numeric, sample_size integer,
  serial_bucket text, tier text, circ_band text, is_reliable boolean);
CREATE TABLE public.serial_fmv_calibration (
  collection_id uuid, serial_bucket text, factor numeric, PRIMARY KEY (collection_id, serial_bucket));

-- >>> BEGIN verbatim serial_fmv_estimate (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(p_collection_id uuid, p_serial integer, p_circulation integer,
  p_tier text, p_edition_fmv numeric, p_confidence text, p_jersey_number integer, p_edition_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE r jsonb; v_f numeric; v_est numeric;
BEGIN
  r := public.serial_fmv_estimate_uncalibrated(p_collection_id, p_serial, p_circulation, p_tier,
         p_edition_fmv, p_confidence, p_jersey_number, p_edition_id);
  IF r IS NULL OR (r->>'estimate_usd') IS NULL THEN RETURN r; END IF;
  SELECT c.factor INTO v_f FROM public.serial_fmv_calibration c
   WHERE c.collection_id = p_collection_id AND c.serial_bucket = r->>'serial_bucket';
  IF v_f IS NULL OR v_f <= 0 OR v_f = 1 THEN RETURN r; END IF;
  v_est := GREATEST(p_edition_fmv, (r->>'estimate_usd')::numeric / v_f);
  RETURN r || jsonb_build_object('estimate_usd', round(v_est, 2),
     'multiplier', round(v_est / p_edition_fmv, 2),
     'uncalibrated_estimate_usd', (r->>'estimate_usd')::numeric,
     'calibration_factor', round(v_f, 3), 'calibration', 'serial-cal-1.0');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.serial_fmv_estimate_uncalibrated(
  p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text,
  p_edition_fmv numeric, p_confidence text, p_jersey_number integer, p_edition_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bucket text; v_band text; v_mult numeric; v_sample integer; v_basis text; v_estimate numeric;
  v_k numeric; v_beta numeric; v_r numeric; v_fmin numeric; v_fmax numeric; v_model_tier text; v_fmv_clamped numeric;
  v_label text; v_lowconf boolean := false;
  v_pm public.serial_fmv_pooled_model%ROWTYPE;
  v_set_id uuid; v_player_id uuid; v_jersey integer;
  v_set_eff numeric; v_set_sup integer; v_pl_eff numeric; v_pl_sup integer; v_ln numeric; v_tier text;
  v_js1 boolean := false;
BEGIN
  IF p_serial IS NULL OR p_circulation IS NULL OR p_circulation <= 0
     OR p_edition_fmv IS NULL OR p_edition_fmv <= 0 THEN RETURN NULL; END IF;
  IF upper(coalesce(p_confidence,'')) NOT IN ('HIGH','MEDIUM') THEN RETURN NULL; END IF;
  IF p_serial = 1 THEN v_bucket := 'first';
  ELSIF p_serial = p_circulation THEN v_bucket := 'perfect';
  ELSIF p_jersey_number IS NOT NULL AND p_jersey_number > 1 AND p_serial = p_jersey_number THEN v_bucket := 'jersey';
  ELSE RETURN NULL; END IF;
  v_band := CASE WHEN p_circulation<100 THEN 'ultra' WHEN p_circulation<500 THEN 'low'
                 WHEN p_circulation<2500 THEN 'mid' WHEN p_circulation<10000 THEN 'high' ELSE 'mass' END;
  v_label := CASE v_bucket WHEN 'first' THEN 'estimated #1 premium'
                           WHEN 'perfect' THEN 'estimated perfect-mint premium'
                           ELSE 'estimated jersey-match premium' END;
  v_tier := upper(coalesce(p_tier,''));

  IF p_edition_id IS NOT NULL AND v_bucket IN ('first','perfect') THEN
    SELECT * INTO v_pm FROM public.serial_fmv_pooled_model WHERE collection_id = p_collection_id AND is_active LIMIT 1;
    IF FOUND THEN
      SELECT e.set_id, e.player_id, e.jersey_number INTO v_set_id, v_player_id, v_jersey
        FROM public.editions e WHERE e.id = p_edition_id;
      SELECT effect, support_n INTO v_set_eff, v_set_sup FROM public.serial_fmv_pooled_set_effect
        WHERE collection_id = p_collection_id AND set_id = v_set_id;
      SELECT effect, support_n INTO v_pl_eff, v_pl_sup FROM public.serial_fmv_pooled_player_effect
        WHERE collection_id = p_collection_id AND player_id = v_player_id;
      IF (coalesce(v_set_sup,0) >= v_pm.gate_min_support OR coalesce(v_pl_sup,0) >= v_pm.gate_min_support) THEN
        v_fmv_clamped := LEAST(GREATEST(p_edition_fmv, v_pm.fmv_min), v_pm.fmv_max);
        v_ln := v_pm.intercept + v_pm.b_log_fmv * ln(v_fmv_clamped) + v_pm.b_log_circ * ln(GREATEST(p_circulation,1))
              + CASE v_tier WHEN 'RARE' THEN v_pm.tier_rare WHEN 'LEGENDARY' THEN v_pm.tier_legendary
                            WHEN 'FANDOM' THEN v_pm.tier_fandom ELSE 0 END;
        IF v_bucket = 'perfect' THEN
          v_ln := v_ln + v_pm.bucket_perfect
                + CASE v_tier WHEN 'RARE' THEN v_pm.px_rare WHEN 'LEGENDARY' THEN v_pm.px_legendary
                              WHEN 'FANDOM' THEN v_pm.px_fandom ELSE 0 END;
        END IF;
        v_ln := v_ln + coalesce(v_set_eff,0) + coalesce(v_pl_eff,0);
        -- double-special: #1 serial of a player whose jersey is also 1 (validated ~x1.38 premium)
        IF v_bucket = 'first' AND v_jersey = 1 THEN
          v_ln := v_ln + v_pm.jersey1;
          v_js1 := true;
        END IF;
        v_estimate := GREATEST(p_edition_fmv, p_edition_fmv * exp(v_ln));
        v_estimate := LEAST(GREATEST(v_estimate, p_edition_fmv * v_pm.prem_lo), p_edition_fmv * v_pm.prem_hi);
        RETURN jsonb_build_object('estimate_usd', round(v_estimate,2), 'multiplier', round(v_estimate/p_edition_fmv,2),
          'serial_bucket', v_bucket, 'circ_band', v_band, 'basis', 'pooled_model',
          'set_support', coalesce(v_set_sup,0), 'player_support', coalesce(v_pl_sup,0),
          'jersey1_match', v_js1,
          'model_beta', round(v_pm.b_log_fmv,4), 'algo_version', v_pm.algo_version, 'label', v_label);
      END IF;
    END IF;
  END IF;

  IF v_bucket = 'jersey' THEN
    SELECT k,beta,r,fmv_min,fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
    FROM public.serial_fmv_jersey_model WHERE collection_id=p_collection_id AND is_reliable AND tier=coalesce(p_tier,'UNKNOWN') LIMIT 1;
    IF v_k IS NULL THEN
      SELECT k,beta,r,fmv_min,fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
      FROM public.serial_fmv_jersey_model WHERE collection_id=p_collection_id AND is_reliable AND tier='ALL' LIMIT 1;
    END IF;
    IF v_k IS NULL THEN RETURN NULL; END IF;
    v_fmv_clamped := LEAST(GREATEST(p_edition_fmv,coalesce(v_fmin,p_edition_fmv)),coalesce(v_fmax,p_edition_fmv));
    v_estimate := GREATEST(p_edition_fmv, v_k*power(v_fmv_clamped,v_beta));
    v_lowconf := (p_edition_fmv > coalesce(v_fmax, p_edition_fmv)) OR (v_estimate <= p_edition_fmv*1.05);
    RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_estimate/p_edition_fmv,2),
      'serial_bucket','jersey','circ_band',v_band,'basis','power_model','sample_size',NULL,
      'model_k',round(v_k,4),'model_beta',round(v_beta,4),'model_r',round(v_r,3),'low_confidence',v_lowconf,'label',v_label);
  END IF;

  v_model_tier := CASE WHEN v_bucket = 'perfect' THEN 'ALL' ELSE coalesce(p_tier,'UNKNOWN') END;
  SELECT pm.k,pm.beta,pm.r,pm.fmv_min,pm.fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
  FROM public.serial_fmv_power_model pm
  WHERE pm.collection_id=p_collection_id AND pm.serial_bucket=v_bucket AND pm.tier=v_model_tier AND pm.is_reliable LIMIT 1;
  IF v_k IS NOT NULL THEN
    v_fmv_clamped := LEAST(GREATEST(p_edition_fmv,coalesce(v_fmin,p_edition_fmv)),coalesce(v_fmax,p_edition_fmv));
    v_estimate := GREATEST(p_edition_fmv, v_k*power(v_fmv_clamped,v_beta));
    RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_estimate/p_edition_fmv,2),
      'serial_bucket',v_bucket,'circ_band',v_band,'basis','power_model','sample_size',NULL,
      'model_k',round(v_k,4),'model_beta',round(v_beta,4),'model_r',round(v_r,3),'label',v_label);
  END IF;

  SELECT m.multiplier,m.sample_size INTO v_mult,v_sample
  FROM public.serial_fmv_multipliers m
  WHERE m.collection_id=p_collection_id AND m.serial_bucket=v_bucket AND m.tier=coalesce(p_tier,'UNKNOWN') AND m.circ_band=v_band AND m.is_reliable LIMIT 1;
  IF v_mult IS NOT NULL THEN v_basis:='tier_circ';
  ELSE
    SELECT m.multiplier,m.sample_size INTO v_mult,v_sample
    FROM public.serial_fmv_multipliers m
    WHERE m.collection_id=p_collection_id AND m.serial_bucket=v_bucket AND m.tier='ALL' AND m.circ_band='ALL' AND m.is_reliable LIMIT 1;
    v_basis:='aggregate';
  END IF;
  IF v_mult IS NULL THEN RETURN NULL; END IF;
  v_estimate := GREATEST(p_edition_fmv, p_edition_fmv*v_mult);
  RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_mult,2),
    'serial_bucket',v_bucket,'circ_band',v_band,'basis',v_basis,'sample_size',v_sample,'label',v_label);
END;
$function$;

-- <<< END verbatim serial_fmv_estimate <<<

-- Fixed ids used throughout.
\set cid '''11111111-1111-1111-1111-111111111111'''
\set eid '''22222222-2222-2222-2222-222222222222'''
\set sid '''33333333-3333-3333-3333-333333333333'''
\set pid '''44444444-4444-4444-4444-444444444444'''

INSERT INTO public.editions (id, set_id, player_id, jersey_number)
VALUES (:eid::uuid, :sid::uuid, :pid::uuid, 1);

-- ── 1. Input guards all return NULL ──────────────────────────────────────────
SELECT _assert(public.serial_fmv_estimate(:cid::uuid, NULL, 100, 'RARE', 10, 'HIGH', NULL, NULL) IS NULL, 'null serial -> NULL');
SELECT _assert(public.serial_fmv_estimate(:cid::uuid, 1, 0, 'RARE', 10, 'HIGH', NULL, NULL) IS NULL, 'circ<=0 -> NULL');
SELECT _assert(public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 0, 'HIGH', NULL, NULL) IS NULL, 'fmv<=0 -> NULL');
SELECT _assert(public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'LOW', NULL, NULL) IS NULL, 'LOW confidence -> NULL');
SELECT _assert(public.serial_fmv_estimate(:cid::uuid, 500, 2500, 'RARE', 10, 'HIGH', NULL, NULL) IS NULL, 'non-special serial -> NULL');
-- No models seeded yet: even a #1 serial has no engine -> NULL.
SELECT _assert(public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL) IS NULL, 'no model seeded -> NULL');

-- ── 2. Grid fallback: tier_circ match ────────────────────────────────────────
-- circ=100 maps to circ_band 'low' (band 'ultra' is circ<100), so seed the 'low' row.
INSERT INTO public.serial_fmv_multipliers (collection_id, multiplier, sample_size, serial_bucket, tier, circ_band, is_reliable)
VALUES (:cid::uuid, 3.0, 12, 'first', 'RARE', 'low', true);
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'basis', 'tier_circ', 'grid tier_circ basis');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'estimate_usd', '30.00', 'grid tier_circ estimate = fmv*mult');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'multiplier', '3.00', 'grid tier_circ multiplier');

-- ── 3. Grid aggregate fallback (tier/circ miss, ALL/ALL present) ─────────────
INSERT INTO public.serial_fmv_multipliers (collection_id, multiplier, sample_size, serial_bucket, tier, circ_band, is_reliable)
VALUES (:cid::uuid, 1.5, 99, 'first', 'ALL', 'ALL', true);
-- COMMON/'low' has no tier_circ row -> falls to ALL/ALL aggregate.
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'COMMON', 10, 'HIGH', NULL, NULL))->>'basis', 'aggregate', 'grid aggregate basis');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'COMMON', 10, 'HIGH', NULL, NULL))->>'estimate_usd', '15.00', 'grid aggregate estimate');

-- ── 4. Power-law beats grid (precedence) ─────────────────────────────────────
INSERT INTO public.serial_fmv_power_model (collection_id, k, beta, r, fmv_min, fmv_max, is_reliable, serial_bucket, tier)
VALUES (:cid::uuid, 4.0, 1.0, 0.9, NULL, NULL, true, 'first', 'RARE');
-- estimate = max(fmv, k*fmv^beta) = max(10, 4*10^1) = 40
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'basis', 'power_model', 'power beats grid');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'estimate_usd', '40.00', 'power-law estimate');

-- ── 5. estimate is floored at edition_fmv (never below base) ──────────────────
-- a multiplier < 1 grid row still floors at fmv.
INSERT INTO public.serial_fmv_multipliers (collection_id, multiplier, sample_size, serial_bucket, tier, circ_band, is_reliable)
VALUES (:cid::uuid, 0.4, 7, 'perfect', 'LEGENDARY', 'ultra', true);
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 50, 50, 'LEGENDARY', 25, 'HIGH', NULL, NULL))->>'estimate_usd', '25.00', 'estimate floored at edition_fmv');

-- ── 6. Pooled model beats power-law, stamps jersey1_match for a #1/jersey-1 ───
INSERT INTO public.serial_fmv_pooled_model
  (collection_id, is_active, gate_min_support, fmv_min, fmv_max, intercept, b_log_fmv, b_log_circ,
   tier_rare, tier_legendary, tier_fandom, bucket_perfect, px_rare, px_legendary, px_fandom,
   prem_lo, prem_hi, jersey1, algo_version)
VALUES (:cid::uuid, true, 6, 1, 100000, 0, 0, 0,
   0, 0, 0, 0, 0, 0, 0,
   1, 1000, 0.322, 'pooled-1.2.0');   -- all coeffs 0 so exp(ln)=exp(0)=1 -> multiplier 1.0 before jersey1
INSERT INTO public.serial_fmv_pooled_set_effect (collection_id, set_id, effect, support_n)
VALUES (:cid::uuid, :sid::uuid, 0, 50);   -- support 50 >= gate 6

-- edition jersey_number=1 + serial 1 -> jersey1 term applies: ln = 0.322 -> mult exp(0.322)=1.38
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, :eid::uuid))->>'basis', 'pooled_model', 'pooled beats power');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, :eid::uuid))->>'jersey1_match', 'true', 'double-special jersey1_match=true');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, :eid::uuid))->>'estimate_usd', '13.80', 'jersey1 premium exp(0.322)~1.38 -> 13.80');

-- support BELOW gate -> pooled does NOT fire, falls back to power-law.
UPDATE public.serial_fmv_pooled_set_effect SET support_n = 3 WHERE collection_id = :cid::uuid;
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, :eid::uuid))->>'basis', 'power_model', 'pooled below gate -> falls to power');

-- ── 7. serial-cal-1.0 calibration (2026-11-25) ─────────────────────────────────
-- current engine for (#1, 100, RARE, fmv 10, no edition id) is the power-law: 40.00 uncalibrated.
SELECT _assert((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL)) ? 'calibration_factor' = false,
  'no factor seeded -> model value passes through unstamped');
INSERT INTO public.serial_fmv_calibration VALUES (:cid::uuid, 'first', 2), (:cid::uuid, 'perfect', 2.5);
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'estimate_usd', '20.00', 'factor divides the estimate (40 / 2)');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'multiplier', '2.00', 'multiplier recomputed from the calibrated estimate');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'uncalibrated_estimate_usd', '40.00', 'model value kept beside it');
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'calibration_factor', '2.000', 'factor stamped');
SELECT _assert_eq((public.serial_fmv_estimate_uncalibrated(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'estimate_usd', '40.00', 'CONTROL: the model itself is untouched');
-- the edition_fmv floor still holds after dividing (perfect /50: model 25.00, / 2.5 = 10 -> floored to 25)
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 50, 50, 'LEGENDARY', 25, 'HIGH', NULL, NULL))->>'estimate_usd', '25.00', 'calibrated estimate floored at edition_fmv');
-- a factor of 1 is a pass-through; a non-special serial stays NULL through the wrapper
UPDATE public.serial_fmv_calibration SET factor = 1 WHERE serial_bucket = 'first';
SELECT _assert_eq((public.serial_fmv_estimate(:cid::uuid, 1, 100, 'RARE', 10, 'HIGH', NULL, NULL))->>'estimate_usd', '40.00', 'factor 1 -> model value');
SELECT _assert(public.serial_fmv_estimate(:cid::uuid, 500, 2500, 'RARE', 10, 'HIGH', NULL, NULL) IS NULL, 'non-special serial -> NULL through the wrapper');

SELECT '✓ serial_fmv_estimate: all assertions passed' AS result;

ROLLBACK;
