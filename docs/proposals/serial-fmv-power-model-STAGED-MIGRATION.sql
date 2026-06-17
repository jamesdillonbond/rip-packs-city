-- ============================================================================
-- STAGED — NOT APPLIED.  REVIEW-GATED.
-- `serial_fmv_estimate` is live FMV / pricing route logic, on CLAUDE.md's
-- never-autonomously-ship list. This file is a reviewed artifact for sign-off,
-- not something to `apply_migration`. When approved, paste into a dedicated
-- migration session as:  audit_20260617_serial_fmv_power_model
--
-- Companion to docs/proposals/serial-fmv-fmv-aware-multiplier-2026-06-17.md
-- (the v2 proposal carries the evidence, fits, and the full live acceptance test).
--
-- What it does (3 objects):
--   1. serial_fmv_power_model        — fitted (k, beta) coefficient table
--   2. compute_serial_fmv_power_model— log-log OLS fit job (run by the weekly cron)
--   3. serial_fmv_estimate (REPLACE)  — power-law where a reliable model exists,
--                                       else the EXISTING grid path unchanged
--
-- Design decisions locked in review (see the proposal for the data behind each):
--   * Functional form = power law  price ≈ k·fmv^beta  (beats flat-grid and
--     additive floor+slope head-to-head: COMMON #1 median |%err| 92% grid /
--     68% additive / 52% power).
--   * Fit on HIGH/MEDIUM editions ONLY — that is the exact population
--     serial_fmv_estimate serves (it hard-gates on confidence). Fitting on all
--     confidences (what the v1 proposal did) doubles n with rows the estimate
--     can never price and destabilises the thin perfect cells.
--   * `first`  : per-tier fit (COMMON / RARE / LEGENDARY are well-separated).
--   * `perfect`: ONE pooled fit across tiers (per-tier perfect is n=6..21 and
--     unstable; the beta≈0.54 FMV term carries the tier spread — it lands KD
--     perfect at ~$144 with no LEGENDARY-specific cell).
--   * FANDOM #1 has a broken fit (beta<0) -> never reliable -> falls through to
--     the existing grid path (UNCHANGED, still `coarse`). FANDOM disposition is
--     an OPEN review item; this migration does not make it worse.
--   * The returned `multiplier` is the EFFECTIVE multiplier (estimate/fmv) so the
--     board view's existing estimate_quality CASE keeps working and auto-relaxes
--     correctly (e.g. KD perfect effective mult ≈1.0 -> tight). No view change.
-- ============================================================================

BEGIN;

-- 1. Coefficient table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.serial_fmv_power_model (
  collection_id uuid        NOT NULL,
  serial_bucket text        NOT NULL,           -- 'first' | 'perfect'
  tier          text        NOT NULL,           -- specific tier for 'first'; 'ALL' for pooled 'perfect'
  k             numeric     NOT NULL,
  beta          numeric     NOT NULL,
  sample_size   integer     NOT NULL,
  r             numeric,                          -- Pearson corr of ln(price)~ln(fmv)
  fmv_min       numeric,                          -- fitted FMV domain (extrapolation clamp)
  fmv_max       numeric,
  is_reliable   boolean     NOT NULL DEFAULT false,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, serial_bucket, tier)
);

ALTER TABLE public.serial_fmv_power_model ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policy: only the SECURITY DEFINER estimate fn reads it.
GRANT SELECT ON public.serial_fmv_power_model TO service_role;

COMMENT ON TABLE public.serial_fmv_power_model IS
  'Fitted serial-FMV power-law coefficients (price ~ k*fmv^beta) per (bucket,tier). '
  'first=per-tier, perfect=pooled (tier=ALL). Fit on HIGH/MEDIUM editions only. '
  'Refreshed weekly by compute_serial_fmv_power_model. Read by serial_fmv_estimate.';

-- 2. Fit job -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_serial_fmv_power_model(
  p_collection_id  uuid    DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid,
  p_lookback_days  integer DEFAULT 180,
  p_min_sample     integer DEFAULT 40,
  p_min_r          numeric DEFAULT 0.35
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_rows integer;
BEGIN
  DELETE FROM public.serial_fmv_power_model WHERE collection_id = p_collection_id;

  WITH latest_fmv AS (
    SELECT DISTINCT ON (fs.edition_id)
           fs.edition_id, fs.fmv_usd, fs.confidence::text AS confidence
    FROM public.fmv_snapshots fs
    WHERE fs.collection_id = p_collection_id
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  d AS (
    SELECT s.price_usd, lf.fmv_usd,
      CASE WHEN s.serial_number = 1                    THEN 'first'
           WHEN s.serial_number = e.circulation_count  THEN 'perfect' END AS bucket,
      e.tier::text AS tier
    FROM public.sales s
    JOIN public.editions e   ON e.id = s.edition_id
    JOIN latest_fmv lf       ON lf.edition_id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND s.sold_at > now() - make_interval(days => p_lookback_days)
      AND s.price_usd > 0
      AND e.circulation_count > 0
      AND lf.fmv_usd > 0
      AND lf.confidence IN ('HIGH','MEDIUM')          -- match the estimate's gate
      AND (s.serial_number = 1 OR s.serial_number = e.circulation_count)
  ),
  fits AS (
    -- first: one fit per tier
    SELECT 'first'::text AS serial_bucket, d.tier,
      exp(regr_intercept(ln(price_usd), ln(fmv_usd))) AS k,
      regr_slope(ln(price_usd), ln(fmv_usd))          AS beta,
      count(*)::int                                   AS n,
      corr(ln(price_usd), ln(fmv_usd))                AS r,
      min(fmv_usd) AS fmv_min, max(fmv_usd) AS fmv_max
    FROM d
    WHERE d.bucket = 'first' AND d.tier IS NOT NULL
    GROUP BY d.tier
    UNION ALL
    -- perfect: pooled across tiers (per-tier perfect is too thin/unstable)
    SELECT 'perfect', 'ALL',
      exp(regr_intercept(ln(price_usd), ln(fmv_usd))),
      regr_slope(ln(price_usd), ln(fmv_usd)),
      count(*)::int,
      corr(ln(price_usd), ln(fmv_usd)),
      min(fmv_usd), max(fmv_usd)
    FROM d
    WHERE d.bucket = 'perfect'
  )
  INSERT INTO public.serial_fmv_power_model
    (collection_id, serial_bucket, tier, k, beta, sample_size, r,
     fmv_min, fmv_max, is_reliable, computed_at)
  SELECT p_collection_id, f.serial_bucket, f.tier,
    round(f.k::numeric, 4), round(f.beta::numeric, 4), f.n, round(f.r::numeric, 3),
    round(f.fmv_min::numeric, 2), round(f.fmv_max::numeric, 2),
    -- reliable = enough data, non-trivial correlation, sane sub-linear-ish slope.
    -- (COMMON #1 r≈0.44 passes: noisy but still ~2x better than the flat grid;
    --  FANDOM #1 beta<0 fails -> never used.)
    (f.n >= p_min_sample AND f.r >= p_min_r AND f.beta > 0.15 AND f.beta < 1.25),
    now()
  FROM fits f
  WHERE f.k IS NOT NULL AND f.beta IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

GRANT EXECUTE ON FUNCTION
  public.compute_serial_fmv_power_model(uuid, integer, integer, numeric)
  TO service_role;

-- 3. serial_fmv_estimate — power-law-first, grid fallback unchanged -----------
CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(
  p_collection_id uuid,
  p_serial        integer,
  p_circulation   integer,
  p_tier          text,
  p_edition_fmv   numeric,
  p_confidence    text
) RETURNS jsonb
  LANGUAGE plpgsql
  STABLE SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_bucket        text;
  v_band          text;
  v_mult          numeric;
  v_sample        integer;
  v_basis         text;
  v_estimate      numeric;
  v_k             numeric;
  v_beta          numeric;
  v_r             numeric;
  v_fmin          numeric;
  v_fmax          numeric;
  v_model_tier    text;
  v_fmv_clamped   numeric;
BEGIN
  -- Hard gates (unchanged): positive FMV + circulation, HIGH/MEDIUM base only.
  IF p_serial IS NULL OR p_circulation IS NULL OR p_circulation <= 0
     OR p_edition_fmv IS NULL OR p_edition_fmv <= 0 THEN
    RETURN NULL;
  END IF;
  IF upper(coalesce(p_confidence, '')) NOT IN ('HIGH', 'MEDIUM') THEN
    RETURN NULL;
  END IF;

  IF p_serial = 1 THEN
    v_bucket := 'first';
  ELSIF p_serial = p_circulation THEN
    v_bucket := 'perfect';
  ELSE
    RETURN NULL;  -- low / normal serials: model barely beats edition FMV.
  END IF;

  v_band := CASE
    WHEN p_circulation < 100   THEN 'ultra'
    WHEN p_circulation < 500   THEN 'low'
    WHEN p_circulation < 2500  THEN 'mid'
    WHEN p_circulation < 10000 THEN 'high'
    ELSE 'mass' END;

  -- ---- Power-law model first --------------------------------------------
  -- per-tier for 'first'; pooled ('ALL') for 'perfect'.
  v_model_tier := CASE WHEN v_bucket = 'perfect'
                       THEN 'ALL'
                       ELSE coalesce(p_tier, 'UNKNOWN') END;

  SELECT pm.k, pm.beta, pm.r, pm.fmv_min, pm.fmv_max
    INTO v_k, v_beta, v_r, v_fmin, v_fmax
  FROM public.serial_fmv_power_model pm
  WHERE pm.collection_id = p_collection_id
    AND pm.serial_bucket = v_bucket
    AND pm.tier          = v_model_tier
    AND pm.is_reliable
  LIMIT 1;

  IF v_k IS NOT NULL THEN
    -- Clamp the FMV into the fitted domain so we never extrapolate the power
    -- law past observed support; then floor at the edition number itself.
    v_fmv_clamped := LEAST(
                       GREATEST(p_edition_fmv, coalesce(v_fmin, p_edition_fmv)),
                       coalesce(v_fmax, p_edition_fmv));
    v_estimate := GREATEST(p_edition_fmv, v_k * power(v_fmv_clamped, v_beta));

    RETURN jsonb_build_object(
      'estimate_usd',  round(v_estimate, 2),
      -- EFFECTIVE multiplier — keeps the board's estimate_quality CASE valid.
      'multiplier',    round(v_estimate / p_edition_fmv, 2),
      'serial_bucket', v_bucket,
      'circ_band',     v_band,
      'basis',         'power_model',
      'sample_size',   NULL,
      'model_k',       round(v_k, 4),
      'model_beta',    round(v_beta, 4),
      'model_r',       round(v_r, 3),
      'label',         CASE WHEN v_bucket = 'first'
                            THEN 'estimated #1 premium'
                            ELSE 'estimated perfect-mint premium' END
    );
  END IF;

  -- ---- Fallback: existing reliable-grid multiplier path (UNCHANGED) -------
  SELECT m.multiplier, m.sample_size INTO v_mult, v_sample
  FROM public.serial_fmv_multipliers m
  WHERE m.collection_id = p_collection_id
    AND m.serial_bucket = v_bucket
    AND m.tier          = coalesce(p_tier, 'UNKNOWN')
    AND m.circ_band     = v_band
    AND m.is_reliable
  LIMIT 1;

  IF v_mult IS NOT NULL THEN
    v_basis := 'tier_circ';
  ELSE
    SELECT m.multiplier, m.sample_size INTO v_mult, v_sample
    FROM public.serial_fmv_multipliers m
    WHERE m.collection_id = p_collection_id
      AND m.serial_bucket = v_bucket
      AND m.tier = 'ALL' AND m.circ_band = 'ALL'
      AND m.is_reliable
    LIMIT 1;
    v_basis := 'aggregate';
  END IF;

  IF v_mult IS NULL THEN
    RETURN NULL;
  END IF;

  v_estimate := GREATEST(p_edition_fmv, p_edition_fmv * v_mult);

  RETURN jsonb_build_object(
    'estimate_usd',  round(v_estimate, 2),
    'multiplier',    round(v_mult, 2),
    'serial_bucket', v_bucket,
    'circ_band',     v_band,
    'basis',         v_basis,
    'sample_size',   v_sample,
    'label',         CASE WHEN v_bucket = 'first'
                          THEN 'estimated #1 premium'
                          ELSE 'estimated perfect-mint premium' END
  );
END;
$fn$;

-- CREATE OR REPLACE preserves grants, but re-assert to be safe (rpc-migration
-- checklist). Current grants: anon, authenticated, service_role, postgres.
GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text)
  TO anon, authenticated, service_role;

COMMIT;

-- ---- Post-apply (run in the same session, not inside the txn) --------------
--  SELECT public.compute_serial_fmv_power_model();            -- initial populate
--  SELECT * FROM public.serial_fmv_power_model ORDER BY serial_bucket, tier;
--  -- expect ~ first/COMMON(reliable), first/RARE(reliable), first/LEGENDARY(reliable),
--  --          first/FANDOM(is_reliable=false), perfect/ALL(reliable)
--  -- then re-pull topshot_underpriced_serials_board and confirm the acceptance
--  -- test in the proposal (KD perfect ~$144, Azzi Fudd not-a-deal, McLaughlin still a deal).
--  SELECT * FROM public.check_public_security_invariants();   -- expect []
--  SELECT * FROM public.check_secdef_anon_execute_violations(); -- expect []  (new table is service_role-only; new fit fn not anon)
--
-- OPERATOR DEPENDENCY: the weekly `refresh-serial-fmv-multipliers` cron must
-- also call compute_serial_fmv_power_model() (add one line to that route's
-- after() block) AND the cron itself must actually fire — it currently has 0
-- pipeline_runs (ledger item SERIAL-FMV-MULT-CRON). Without it the model table
-- goes stale exactly like the grid does today.

-- ---- REVERT ----------------------------------------------------------------
--  CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(...)  -- prior body,
--    captured at the top of docs/proposals/serial-fmv-fmv-aware-multiplier-2026-06-17.md
--    (the pre-change definition snapshot).
--  DROP FUNCTION IF EXISTS public.compute_serial_fmv_power_model(uuid,integer,integer,numeric);
--  DROP TABLE IF EXISTS public.serial_fmv_power_model;
