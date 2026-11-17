-- audit_20261002_panini_pack_ev_wnba_sales_model
--
-- WHY. The FMV-based WNBA pack EV (panini_pack_ev_model_wnba_2026, v0.2) cannot price the pack: on
-- 2026-10-02 sale-backed editions carried only 10-22% of the base / insert / FOTL-exclusive families'
-- value, so the board said "not modeled" for both packs, while 1,315 real WNBA sales existed. A plain
-- average of those sales is biased the other way: the rare parallels trade thinly and their first sales
-- are stars (Plum Blossom: 8 of 83 editions sold, two at 1,000 USD), so it prices a random pull like a star.
--
-- MODEL. log(sale) = player effect + parallel effect, fit by alternating least squares on every
-- recorded 2420 sale. The liquid parallels (Silver 172/196 editions sold, Purple 155/187) pin each
-- player; the thin parallels only need their multiplier. Every edition still in packs then gets a
-- predicted price; a family value is the still_in_packs-weighted mean (x the family retransformation
-- factor, mean of exp(residual)) and the remain-weighted median (typical). Imputation is generic:
-- a parallel with no sale takes its family + print-run siblings; one with < 3 sales is floored at the
-- best-priced larger-print-run parallel of its family. A parallel with neither is left out, not priced
-- at the average. Pack EV in panini_pack_ev_model_wnba_2026_sales: Hobby = 2 silver + 1.75 base +
-- 0.25 insert, FOTL = Hobby + 1 exclusive (Panini pack_label/description, 2026-09-29).
-- Gate: a pack is modeled only with >= 10 sales in every family it draws from and a fit < 6 h old
-- (a stalled refresh withholds the EV; it never serves a stale one).
-- First fit (2026-10-02 ~6:05 PM PT): 1,315 sales, 1,469 editions, log RMSE 0.33-0.67 per family;
-- Hobby mean 22 / typical 9 vs 30; FOTL mean 55 / typical 18 vs 150. Matches the 20,000-pack
-- Monte-Carlo in docs/strategy/panini-fmv-packev-methodology.md (FOTL mean 45-56, Hobby 16-22).
--
-- APPLIED via a base64 DO/EXECUTE wrapper of exactly this text (live prosrc md5 = this body's md5,
-- 52d6b82d...): the MCP transport stalled on the plain-text body (never reached Postgres).
-- REVERT: DROP VIEW public.panini_pack_ev_model_wnba_2026_sales (board first - see its migration);
--         DROP FUNCTION public.refresh_panini_pack_ev_sales_model(int).

-- anon-exec: revoked (refresh_panini_pack_ev_sales_model) — NEW function: REVOKE FROM PUBLIC, anon, authenticated in one statement below; GRANT to service_role + cron_heavy (the pg_cron caller).
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
    WHERE d.remain > 0 AND b.imputed IS DISTINCT FROM 'unpriced';

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

REVOKE ALL ON FUNCTION public.refresh_panini_pack_ev_sales_model(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_pack_ev_sales_model(int) TO service_role, cron_heavy;

CREATE OR REPLACE VIEW public.panini_pack_ev_model_wnba_2026_sales WITH (security_invoker = on) AS
WITH f AS (
  SELECT product_set_id,
    max(mean_value) FILTER (WHERE fam = 'silver') AS silver_m, max(typical_value) FILTER (WHERE fam = 'silver') AS silver_t,
    max(mean_value) FILTER (WHERE fam = 'base') AS base_m, max(typical_value) FILTER (WHERE fam = 'base') AS base_t,
    max(mean_value) FILTER (WHERE fam = 'insert') AS insert_m, max(typical_value) FILTER (WHERE fam = 'insert') AS insert_t,
    max(mean_value) FILTER (WHERE fam = 'fotl') AS fotl_m, max(typical_value) FILTER (WHERE fam = 'fotl') AS fotl_t,
    COALESCE(max(n_sales) FILTER (WHERE fam = 'silver'), 0) AS silver_n,
    COALESCE(max(n_sales) FILTER (WHERE fam = 'base'), 0) AS base_n,
    COALESCE(max(n_sales) FILTER (WHERE fam = 'insert'), 0) AS insert_n,
    COALESCE(max(n_sales) FILTER (WHERE fam = 'fotl'), 0) AS fotl_n,
    min(computed_at) AS computed_at
  FROM public.panini_pack_ev_sales_families
  WHERE product_set_id = 2420
  GROUP BY product_set_id
)
SELECT product_set_id,
  round(silver_m) AS silver_ev,
  round(base_m) AS base_parallel_ev,
  round(insert_m) AS insert_ev,
  round(fotl_m) AS fotl_exclusive_ev,
  round(2 * silver_m + 1.75 * base_m + 0.25 * insert_m) AS hobby_actual_ev,
  round(2 * silver_t + 1.75 * base_t + 0.25 * insert_t) AS hobby_typical_ev,
  round(2 * silver_m + 1.75 * base_m + 0.25 * insert_m + fotl_m) AS fotl_actual_ev,
  round(2 * silver_t + 1.75 * base_t + 0.25 * insert_t + fotl_t) AS fotl_typical_ev,
  (silver_n >= 10 AND base_n >= 10 AND insert_n >= 10
     AND silver_m IS NOT NULL AND base_m IS NOT NULL AND insert_m IS NOT NULL
     AND computed_at > now() - interval '6 hours') AS hobby_modeled,
  (silver_n >= 10 AND base_n >= 10 AND insert_n >= 10 AND fotl_n >= 10
     AND silver_m IS NOT NULL AND base_m IS NOT NULL AND insert_m IS NOT NULL AND fotl_m IS NOT NULL
     AND computed_at > now() - interval '6 hours') AS fotl_modeled,
  silver_n, base_n, insert_n, fotl_n, computed_at,
  'panini-pack-ev-wnba-sales-1.0 · 2026 Prizm WNBA (setId 2420) · priced from SALES, not asks: log(sale) = player effect + parallel effect fit on every recorded sale (refresh_panini_pack_ev_sales_model, hourly), predicted for every card still in packs and weighted by still_in_packs · mean = remain-weighted predicted price x the family''s retransformation factor; typical = sum of family medians · Hobby 4 cards = 2 Silver #/296 + 1 non-Silver base parallel + (base parallel or insert 1/4) · FOTL = Hobby + 1 exclusive (Cherry Blossom #/17, Plum Blossom #/8, Lotus Flower #/3) · per Panini pack_label/description 2026-09-29 · modeled only with >=10 sales in every family of the pack and a fit under 6 h old'::text AS model_note
FROM f;

REVOKE ALL ON public.panini_pack_ev_model_wnba_2026_sales FROM anon, authenticated;
GRANT SELECT ON public.panini_pack_ev_model_wnba_2026_sales TO service_role;

