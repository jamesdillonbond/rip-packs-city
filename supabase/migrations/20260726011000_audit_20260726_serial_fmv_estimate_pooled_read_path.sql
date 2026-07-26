-- audit_20260726_serial_fmv_estimate_pooled_read_path
-- Adds the pooled multi-factor model as the first-choice read path for first/perfect serials.
-- Canonical 8-arg serial_fmv_estimate(cid, serial, circ, tier, fmv, confidence, jersey_number, edition_id)
-- resolves pooled -> jersey -> power-law -> grid; the 6-arg / 7-arg-integer(jersey) / 7-arg-uuid(edition_id)
-- overloads all delegate to it. Pooled fires only when p_edition_id is given, the model is_active, and the
-- edition's set (or player) has training support >= gate_min_support; otherwise the exact prior power-law/grid
-- (and jersey) behavior is preserved (every existing caller passes edition_id => NULL and is byte-identical).
-- Consumers opt into pooled by passing p_edition_id (edition context already in scope for them).
-- REVERT: recreate the prior 6-arg (plpgsql, power+grid) and 7-arg-integer (jersey) bodies from migration
--   history and DROP the 8-arg and 7-arg-uuid overloads. (Pooled tables can stay; nothing reads them then.)

CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(
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
  v_set_id uuid; v_player_id uuid;
  v_set_eff numeric; v_set_sup integer; v_pl_eff numeric; v_pl_sup integer; v_ln numeric; v_tier text;
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

  -- Pooled multi-factor model (first choice for first/perfect when edition context is given)
  IF p_edition_id IS NOT NULL AND v_bucket IN ('first','perfect') THEN
    SELECT * INTO v_pm FROM public.serial_fmv_pooled_model WHERE collection_id = p_collection_id AND is_active LIMIT 1;
    IF FOUND THEN
      SELECT e.set_id, e.player_id INTO v_set_id, v_player_id FROM public.editions e WHERE e.id = p_edition_id;
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
        v_estimate := GREATEST(p_edition_fmv, p_edition_fmv * exp(v_ln));
        v_estimate := LEAST(GREATEST(v_estimate, p_edition_fmv * v_pm.prem_lo), p_edition_fmv * v_pm.prem_hi);
        RETURN jsonb_build_object('estimate_usd', round(v_estimate,2), 'multiplier', round(v_estimate/p_edition_fmv,2),
          'serial_bucket', v_bucket, 'circ_band', v_band, 'basis', 'pooled_model',
          'set_support', coalesce(v_set_sup,0), 'player_support', coalesce(v_pl_sup,0),
          'model_beta', round(v_pm.b_log_fmv,4), 'algo_version', v_pm.algo_version, 'label', v_label);
      END IF;
    END IF;
  END IF;

  -- Jersey power model (unchanged)
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

  -- Power-law model (first/perfect fallthrough, unchanged)
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

  -- Grid fallback (unchanged)
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
GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text,integer,uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(
  p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text,
  p_edition_fmv numeric, p_confidence text, p_edition_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
  SELECT public.serial_fmv_estimate(p_collection_id,p_serial,p_circulation,p_tier,p_edition_fmv,p_confidence,NULL::integer,p_edition_id);
$function$;
GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text,uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(
  p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text,
  p_edition_fmv numeric, p_confidence text, p_jersey_number integer)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
  SELECT public.serial_fmv_estimate(p_collection_id,p_serial,p_circulation,p_tier,p_edition_fmv,p_confidence,p_jersey_number,NULL::uuid);
$function$;
GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text,integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(
  p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text,
  p_edition_fmv numeric, p_confidence text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
  SELECT public.serial_fmv_estimate(p_collection_id,p_serial,p_circulation,p_tier,p_edition_fmv,p_confidence,NULL::integer,NULL::uuid);
$function$;
GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text) TO anon, authenticated, service_role;
