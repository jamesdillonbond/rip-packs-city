-- 2026 WNBA Prizm sales model: White Sparkle (own pack 1062) leaves the Hobby/FOTL remaining-pool prediction; stays in the regression.
-- Only change vs 20261003010736: one predicate on sm_pred. See repo migration 20261122180000.
-- anon-exec: unchanged (refresh_panini_pack_ev_sales_model) — CREATE OR REPLACE of an existing SECURITY DEFINER fn, same signature; ACL preserved (has_function_privilege anon = false, read 2026-11-22).
CREATE OR REPLACE FUNCTION public.refresh_panini_pack_ev_sales_model(p_set_id int DEFAULT 2420)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  c_slug     constant text := 'panini_blockchain';
  v_started  timestamptz := clock_timestamp();
  v_now      timestamptz := now();
  v_obs      integer := NULL;
  v_eds      integer := NULL;
  v_pars     integer := NULL;
  v_fams     integer := NULL;
  v_ok       boolean := true;
  v_err      text := NULL;
  i          integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_panini_pack_ev_sales_model')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    DROP TABLE IF EXISTS pg_temp.sm_ed, pg_temp.sm_obs, pg_temp.sm_a, pg_temp.sm_b, pg_temp.sm_pred;
    -- Card families per Panini's pack contents (2026 Prizm WNBA, read 2026-09-29): the base Silver,
    -- the three FOTL-only base parallels, every other base parallel, and the inserts.
    CREATE TEMP TABLE sm_ed ON COMMIT DROP AS
    SELECT e.external_id, e.player_name AS pl, e.set_name AS par, COALESCE(e.still_in_packs, 0) AS remain,
      CASE WHEN e.set_name ~~* 'Base Prizms Silver' THEN 'silver'
           WHEN e.set_name ~* '^Base Prizms (Cherry Blossom|Plum Blossom|Lotus Flower)$' THEN 'fotl'
           WHEN e.parallel_family = 'base' THEN 'base'
           ELSE 'insert' END AS fam,
      (SELECT max(cs.mint_cap) FROM panini_card_serials cs WHERE cs.edition_external_id = e.external_id) AS cap
    FROM panini_editions e
    WHERE e.product_set_id = p_set_id AND e.player_name IS NOT NULL AND e.set_name IS NOT NULL;
    SELECT count(*) INTO v_eds FROM sm_ed;

    CREATE TEMP TABLE sm_obs ON COMMIT DROP AS
    SELECT d.pl, d.par, d.fam, ln(s.amount_usd::float8) AS y
    FROM panini_sales s JOIN sm_ed d ON d.external_id = s.edition_external_id
    WHERE s.amount_usd > 0;
    SELECT count(*) INTO v_obs FROM sm_obs;

    CREATE TEMP TABLE sm_a ON COMMIT DROP AS SELECT DISTINCT pl, 0::float8 AS v FROM sm_ed;
    CREATE TEMP TABLE sm_b ON COMMIT DROP AS
    SELECT par, min(fam) AS fam, max(cap) AS cap, 0::float8 AS v, NULL::text AS imputed FROM sm_ed GROUP BY par;

    -- log(price) = player effect + parallel effect, alternating least squares. The mean player effect
    -- over players with sales is anchored at 0, so a parallel effect is that parallel's price for an
    -- average player. The liquid parallels pin the players; the thin ones only need their multiplier.
    FOR i IN 1..40 LOOP
      UPDATE sm_b b SET v = q.m FROM (SELECT o.par, avg(o.y - a.v) m FROM sm_obs o JOIN sm_a a USING (pl) GROUP BY o.par) q WHERE b.par = q.par;
      UPDATE sm_a a SET v = q.m FROM (SELECT o.pl, avg(o.y - b.v) m FROM sm_obs o JOIN sm_b b USING (par) GROUP BY o.pl) q WHERE a.pl = q.pl;
      UPDATE sm_b SET v = v + (SELECT avg(v) FROM sm_a WHERE pl IN (SELECT pl FROM sm_obs));
      UPDATE sm_a SET v = v - (SELECT avg(a2.v) FROM sm_a a2 WHERE a2.pl IN (SELECT pl FROM sm_obs)) WHERE pl IN (SELECT pl FROM sm_obs);
    END LOOP;

    -- Imputation, generic (no parallel named):
    -- (1) a parallel with NO sale takes the mean effect of SOLD parallels in its family with the same print run;
    UPDATE sm_b b SET v = q.m, imputed = 'same family + print run'
    FROM (SELECT b0.par, (SELECT avg(b2.v) FROM sm_b b2 WHERE b2.fam = b0.fam AND b2.cap = b0.cap
                           AND b2.par IN (SELECT par FROM sm_obs)) m
          FROM sm_b b0 WHERE b0.par NOT IN (SELECT par FROM sm_obs)) q
    WHERE b.par = q.par AND q.m IS NOT NULL;
    -- (2) a parallel with < 3 sales (or none left unpriced by (1)) never prices below a parallel of its family
    --     with a LARGER print run — scarcity floor (e.g. Lotus Flower #/3 had one 15 USD sale on 2026-10-02).
    UPDATE sm_b b SET v = q.m, imputed = coalesce(b.imputed || ' + ', '') || 'scarcity floor'
    FROM (SELECT b0.par, (SELECT max(b2.v) FROM sm_b b2 WHERE b2.fam = b0.fam AND b2.cap > b0.cap
                           AND b2.par IN (SELECT par FROM sm_obs GROUP BY par HAVING count(*) >= 3)) m
          FROM sm_b b0
          WHERE (SELECT count(*) FROM sm_obs o WHERE o.par = b0.par) < 3) q
    WHERE b.par = q.par AND q.m IS NOT NULL AND q.m > b.v;
    -- A parallel still with no sale and no rule is left out of the values (it is not priced at the average).
    UPDATE sm_b b SET imputed = 'unpriced'
    WHERE b.par NOT IN (SELECT par FROM sm_obs) AND b.imputed IS NULL;

    CREATE TEMP TABLE sm_pred ON COMMIT DROP AS
    SELECT d.fam, d.remain, exp(a.v + b.v) AS p
    FROM sm_ed d JOIN sm_a a USING (pl) JOIN sm_b b USING (par)
    WHERE d.remain > 0 AND b.imputed IS DISTINCT FROM 'unpriced'
      AND d.par !~* '(white sparkle|floral|animal print|giraffe|elephant)';   -- 2026-11-22: own packs (1062), not Hobby/FOTL

    -- Write FIRST, then delete only what this run did not write.
    INSERT INTO panini_pack_ev_sales_parallels AS t (product_set_id, parallel, fam, mint_cap, n_sales, avg_player_price, imputed, computed_at)
    SELECT p_set_id, b.par, b.fam, b.cap, (SELECT count(*) FROM sm_obs o WHERE o.par = b.par), round(exp(b.v)::numeric, 2), b.imputed, v_now
    FROM sm_b b
    ON CONFLICT (product_set_id, parallel) DO UPDATE SET fam = EXCLUDED.fam, mint_cap = EXCLUDED.mint_cap, n_sales = EXCLUDED.n_sales,
      avg_player_price = EXCLUDED.avg_player_price, imputed = EXCLUDED.imputed, computed_at = EXCLUDED.computed_at;
    GET DIAGNOSTICS v_pars = ROW_COUNT;
    DELETE FROM panini_pack_ev_sales_parallels WHERE product_set_id = p_set_id AND computed_at <> v_now;

    INSERT INTO panini_pack_ev_sales_families AS t (product_set_id, fam, n_sales, remain, smear, mean_value, typical_value, log_rmse, computed_at)
    SELECT p_set_id, f.fam,
      (SELECT count(*) FROM sm_obs o WHERE o.fam = f.fam),
      (SELECT COALESCE(sum(remain), 0) FROM sm_pred x WHERE x.fam = f.fam),
      COALESCE((SELECT avg(exp(o.y - a.v - b.v)) FROM sm_obs o JOIN sm_a a USING (pl) JOIN sm_b b USING (par) WHERE o.fam = f.fam), 1),
      (SELECT sum(x.p * x.remain) / NULLIF(sum(x.remain), 0) FROM sm_pred x WHERE x.fam = f.fam)
        * COALESCE((SELECT avg(exp(o.y - a.v - b.v)) FROM sm_obs o JOIN sm_a a USING (pl) JOIN sm_b b USING (par) WHERE o.fam = f.fam), 1),
      -- remain-weighted median of the predicted price: the price of the middle card left in packs
      (SELECT w.p FROM (SELECT x.p, sum(x.remain) OVER (ORDER BY x.p) AS c, sum(x.remain) OVER () AS tot FROM sm_pred x WHERE x.fam = f.fam) w
        WHERE w.c >= w.tot / 2.0 ORDER BY w.p LIMIT 1),
      (SELECT sqrt(avg((o.y - a.v - b.v) ^ 2)) FROM sm_obs o JOIN sm_a a USING (pl) JOIN sm_b b USING (par) WHERE o.fam = f.fam),
      v_now
    FROM (SELECT DISTINCT fam FROM sm_ed) f
    ON CONFLICT (product_set_id, fam) DO UPDATE SET n_sales = EXCLUDED.n_sales, remain = EXCLUDED.remain, smear = EXCLUDED.smear,
      mean_value = EXCLUDED.mean_value, typical_value = EXCLUDED.typical_value, log_rmse = EXCLUDED.log_rmse, computed_at = EXCLUDED.computed_at;
    GET DIAGNOSTICS v_fams = ROW_COUNT;
    DELETE FROM panini_pack_ev_sales_families WHERE product_set_id = p_set_id AND computed_at <> v_now;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- The block rolls back as a whole: nothing is known to be written.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
    v_pars := NULL; v_fams := NULL;
  END;

  PERFORM public.log_pipeline_run('panini-pack-ev-sales-model', v_started, v_obs, v_fams, NULL, v_ok, v_err,
                                  c_slug, NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'product_set_id', p_set_id,
                                                     'editions', v_eds, 'sales', v_obs,
                                                     'parallels_written', v_pars, 'families_written', v_fams));
  RETURN jsonb_build_object('ok', v_ok, 'error', v_err, 'product_set_id', p_set_id, 'editions', v_eds, 'sales', v_obs,
                            'parallels_written', v_pars, 'families_written', v_fams);
END
$function$;