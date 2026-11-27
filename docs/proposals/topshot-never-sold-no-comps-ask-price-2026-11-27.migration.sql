-- 2026-11-27 (Claude Code cloud; Trevor: "Do all that makes sense", on docs/proposals/topshot-never-sold-no-comps-ask-price-2026-11-27.md).
--
-- Top Shot ASK_ONLY prices for a NEVER-SOLD Legendary / Ultimate edition with no set comparable estimate and no
-- offer pull publish 0.9 x the lowest ask, and those editions' first sales came in at ~0.6x that. Every other
-- Top Shot ASK_ONLY arm scores calibrated against real sales (proposal doc).
--
-- RULE (new BEFORE INSERT trigger, fires after fmv_snapshots_pull_topshot_thin_to_best_offer_trg by name):
--   Top Shot, ASK_ONLY, tier LEGENDARY/ULTIMATE, never sold, not already _compcap/_bidpull/_tiercap:
--   price := least(price, greatest(estimate, 0.40 x price, best open edition offer)), tagged _tiercap
--   (_tiercap_bidfloor when the offer set it). estimate = median 180-day sale of OTHER editions in the same tier +
--   set_name (>= 3 editions), else the median first-in-window sale of the tier's editions (>= 5 editions).
-- BACKTEST (point in time: only sales before each first sale; 72 L/U plain-ask first sales, last 150 days):
--   published MdAE 0.588, bias -0.548, within +/-25 % 22 %, WAPE 0.933, published > 2x the sale 28 times;
--   this rule MdAE 0.343, bias -0.138, within +/-25 % 32 %, WAPE 0.480, > 2x 8 times, sale > 2x the price 7 times.
--   The 0.40 floor was chosen over the bare cap (MdAE 0.296) because it under-prices fewer editions (7 vs 10 sold
--   for more than double) — Trevor tuned Legendary pricing by hand on 11-26 against exactly that failure.
-- The estimates live in public.topshot_unsold_tier_comps, refreshed 4x/day by pg_cron (one ~400k-buffer read), so
-- the trigger does a key lookup, never a sales scan.
-- FORWARD TEST: public.topshot_ask_only_forward_test(p_since) scores Top Shot first sales after p_since against the
-- price published just before them, by arm and tier group.
--
-- anon-exec: revoked (refresh_topshot_unsold_tier_comps, fmv_snapshots_tier_cap_topshot_unsold, topshot_ask_only_forward_test) — new functions; revoked from PUBLIC, anon, authenticated below.
--
-- REVERT: DROP TRIGGER fmv_snapshots_tier_cap_topshot_unsold_trg ON public.fmv_snapshots; SELECT cron.unschedule('rpc-topshot-unsold-tier-comps');
--   then restore from public.audit_20261127_topshot_unsold_tiercap_backup:
--   UPDATE public.fmv_snapshots fs SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261127_topshot_unsold_tiercap_backup b WHERE fs.id = b.snapshot_id AND fs.fmv_usd = b.new_fmv_usd;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd, refreshed_at = now()
--     FROM public.audit_20261127_topshot_unsold_tiercap_backup b WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
--   and remove the fmv_restatements rows of source 'audit_20261127_topshot_unsold_tiercap'.

CREATE TABLE IF NOT EXISTS public.topshot_unsold_tier_comps (
  tier text NOT NULL,
  set_name text NOT NULL,           -- '' = the tier-wide fallback row
  est_usd numeric NOT NULL,
  n_editions int NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (tier, set_name)
);
ALTER TABLE public.topshot_unsold_tier_comps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_unsold_tier_comps FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_topshot_unsold_tier_comps()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_written int := 0;
  v_deleted int := 0;
  v_err text;
BEGIN
  BEGIN
    WITH s AS (
      SELECT e.id, e.tier::text AS tier, e.set_name, m.price_usd, m.sold_at
        FROM public.editions e
        JOIN public.sales_market m ON m.edition_id = e.id
       WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
         AND e.tier IN ('LEGENDARY', 'ULTIMATE')
         AND m.collection_id = e.collection_id
         AND m.price_usd > 0
         AND m.sold_at > now() - interval '180 days'
    ), tf AS (
      SELECT DISTINCT ON (id) tier, price_usd FROM s ORDER BY id, sold_at
    ), comps AS (
      SELECT tier, ''::text AS set_name, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd)::numeric AS est, count(*)::int AS n
        FROM tf GROUP BY tier
      UNION ALL
      SELECT tier, set_name, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd)::numeric, count(DISTINCT id)::int
        FROM s WHERE set_name IS NOT NULL GROUP BY tier, set_name
    )
    INSERT INTO public.topshot_unsold_tier_comps (tier, set_name, est_usd, n_editions, computed_at)
    SELECT tier, set_name, round(est, 2), n, v_now FROM comps WHERE est > 0
    ON CONFLICT (tier, set_name) DO UPDATE
      SET est_usd = EXCLUDED.est_usd, n_editions = EXCLUDED.n_editions, computed_at = EXCLUDED.computed_at;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    -- write first, then retire only what this run did not write
    IF v_written > 0 THEN
      DELETE FROM public.topshot_unsold_tier_comps WHERE computed_at < v_now;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    END IF;
  -- a statement_timeout kill (57014) is not in OTHERS; name it so the run record below still sees it. The tail is
  -- one bounded INSERT, and the error is re-raised after it.
  EXCEPTION WHEN query_canceled OR others THEN
    v_err := SQLERRM;
  END;

  BEGIN
    INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, duration_ms, rows_found, rows_written, ok, error, extra)
    VALUES ('topshot-unsold-tier-comps', 'nba_top_shot', v_now, clock_timestamp(),
            round(EXTRACT(EPOCH FROM (clock_timestamp() - v_now)) * 1000)::int, v_written, v_written,
            v_err IS NULL AND v_written > 0, COALESCE(v_err, CASE WHEN v_written = 0 THEN 'no tier/set rows computed' END),
            jsonb_build_object('deleted', v_deleted));
  -- when-others-timeout-blind: intentional — the run record must not fail the refresh it records.
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'refresh_topshot_unsold_tier_comps: %', v_err;
  END IF;
  RETURN jsonb_build_object('ok', v_written > 0, 'written', v_written, 'deleted', v_deleted);
END
$function$;
REVOKE ALL ON FUNCTION public.refresh_topshot_unsold_tier_comps() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_unsold_tier_comps() TO service_role;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_tier_cap_topshot_unsold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tier text;
  v_set text;
  v_est numeric;
  v_bid numeric;
  v_new numeric;
BEGIN
  IF NEW.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND NEW.confidence = 'ASK_ONLY'
     AND NEW.fmv_usd IS NOT NULL AND NEW.fmv_usd > 0
     AND NEW.edition_id IS NOT NULL
     AND COALESCE(NEW.algo_version, '') !~ '_(compcap|bidpull|tiercap)'
  THEN
    SELECT e.tier::text, e.set_name INTO v_tier, v_set FROM public.editions e WHERE e.id = NEW.edition_id;
    IF v_tier IN ('LEGENDARY', 'ULTIMATE')
       AND NOT EXISTS (SELECT 1 FROM public.sales_market s WHERE s.edition_id = NEW.edition_id)
    THEN
      SELECT COALESCE(
               (SELECT c.est_usd FROM public.topshot_unsold_tier_comps c
                 WHERE c.tier = v_tier AND c.set_name = v_set AND c.n_editions >= 3
                   AND c.computed_at > now() - interval '2 days'),
               (SELECT c.est_usd FROM public.topshot_unsold_tier_comps c
                 WHERE c.tier = v_tier AND c.set_name = '' AND c.n_editions >= 5
                   AND c.computed_at > now() - interval '2 days'))
        INTO v_est;
      IF v_est IS NOT NULL AND v_est > 0 THEN
        SELECT max(o.offer_amount_usd) INTO v_bid
          FROM public.offers o
         WHERE o.collection_id = NEW.collection_id
           AND o.edition_id = NEW.edition_id
           AND o.status = 'open'
           AND o.offer_type IN ('edition', 'subedition')
           AND (o.expires_at IS NULL OR o.expires_at > now());
        v_new := round(least(NEW.fmv_usd, greatest(v_est, 0.40 * NEW.fmv_usd, COALESCE(v_bid, 0))), 2);
        IF v_new < NEW.fmv_usd THEN
          NEW.fmv_usd := v_new;
          IF v_bid IS NOT NULL AND v_new <= round(v_bid, 2) THEN
            NEW.algo_version := COALESCE(NEW.algo_version, '') || '_tiercap_bidfloor';
          ELSE
            NEW.algo_version := COALESCE(NEW.algo_version, '') || '_tiercap';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fmv_snapshots_tier_cap_topshot_unsold() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS fmv_snapshots_tier_cap_topshot_unsold_trg ON public.fmv_snapshots;
CREATE TRIGGER fmv_snapshots_tier_cap_topshot_unsold_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_tier_cap_topshot_unsold();

CREATE OR REPLACE FUNCTION public.topshot_ask_only_forward_test(p_since timestamptz DEFAULT '2026-11-27 18:00:00+00')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH fs AS (
    SELECT m.edition_id, min(m.sold_at) AS t0
      FROM public.sales_market m
     WHERE m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND m.price_usd > 0 AND m.sold_at > p_since
     GROUP BY 1
  ), first_sales AS (
    SELECT fs.* FROM fs
     WHERE NOT EXISTS (SELECT 1 FROM public.sales_market p WHERE p.edition_id = fs.edition_id AND p.sold_at < fs.t0 AND p.price_usd > 0)
  ), sc AS (
    SELECT (SELECT m.price_usd FROM public.sales_market m WHERE m.edition_id = f.edition_id AND m.sold_at = f.t0 LIMIT 1) AS actual,
           sn.fmv_usd AS pub,
           CASE WHEN sn.algo_version ~ '_tiercap' THEN 'tiercap' WHEN sn.algo_version ~ '_compcap' THEN 'compcap'
                WHEN sn.algo_version ~ '_bidpull' THEN 'bidpull' ELSE 'ask' END
             || CASE WHEN e.tier IN ('LEGENDARY', 'ULTIMATE') THEN ':LU' ELSE ':other' END AS arm
      FROM first_sales f
      JOIN public.editions e ON e.id = f.edition_id
      JOIN LATERAL (SELECT x.fmv_usd, x.confidence, x.algo_version FROM public.fmv_snapshots x
                     WHERE x.edition_id = f.edition_id AND x.computed_at < f.t0 AND x.fmv_usd > 0
                     ORDER BY x.computed_at DESC LIMIT 1) sn ON sn.confidence = 'ASK_ONLY'
  )
  SELECT COALESCE(jsonb_object_agg(arm, j), '{}'::jsonb)
    FROM (SELECT arm, jsonb_build_object(
                   'n', count(*),
                   'mdae', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(ln(actual / pub)))::numeric, 3),
                   'bias', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ln(actual / pub))::numeric, 3),
                   'within_25pct', round(avg((abs(ln(actual / pub)) <= ln(1.25))::int)::numeric, 3),
                   'wape', round((sum(abs(actual - pub)) / NULLIF(sum(actual), 0))::numeric, 3)) AS j
            FROM sc WHERE actual > 0 GROUP BY arm) z;
$function$;
REVOKE ALL ON FUNCTION public.topshot_ask_only_forward_test(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_ask_only_forward_test(timestamptz) TO service_role;

SELECT public.refresh_topshot_unsold_tier_comps();

SELECT cron.schedule('rpc-topshot-unsold-tier-comps', '41 1,7,13,19 * * *', 'select public.refresh_topshot_unsold_tier_comps()');

CREATE TABLE IF NOT EXISTS public.audit_20261127_topshot_unsold_tiercap_backup (
  edition_id uuid PRIMARY KEY,
  snapshot_id uuid,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  estimate_usd numeric NOT NULL,
  old_algo_version text,
  new_algo_version text,
  restamped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261127_topshot_unsold_tiercap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261127_topshot_unsold_tiercap_backup FROM PUBLIC, anon, authenticated;

WITH cur AS (
  SELECT c.edition_id, c.fmv_usd, e.tier::text AS tier, e.set_name,
         (SELECT max(o.offer_amount_usd) FROM public.offers o
           WHERE o.collection_id = c.collection_id AND o.edition_id = c.edition_id AND o.status = 'open'
             AND o.offer_type IN ('edition', 'subedition') AND (o.expires_at IS NULL OR o.expires_at > now())) AS bid
    FROM public.edition_fmv_current c
    JOIN public.editions e ON e.id = c.edition_id
   WHERE c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND c.confidence = 'ASK_ONLY' AND c.fmv_usd > 0
     AND e.tier IN ('LEGENDARY', 'ULTIMATE')
     AND NOT EXISTS (SELECT 1 FROM public.sales_market m WHERE m.edition_id = c.edition_id)
), est AS (
  SELECT cur.*,
         COALESCE((SELECT t.est_usd FROM public.topshot_unsold_tier_comps t WHERE t.tier = cur.tier AND t.set_name = cur.set_name AND t.n_editions >= 3),
                  (SELECT t.est_usd FROM public.topshot_unsold_tier_comps t WHERE t.tier = cur.tier AND t.set_name = '' AND t.n_editions >= 5)) AS est
    FROM cur
), snap AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND fs.edition_id IN (SELECT edition_id FROM est WHERE est > 0)
   ORDER BY fs.edition_id, fs.computed_at DESC
), calc AS (
  SELECT est.edition_id, s.id AS snapshot_id, est.fmv_usd AS old_fmv, est.est, est.bid, s.algo_version,
         round(least(est.fmv_usd, greatest(est.est, 0.40 * est.fmv_usd, COALESCE(est.bid, 0))), 2) AS new_fmv
    FROM est
    JOIN snap s ON s.edition_id = est.edition_id
   WHERE est.est > 0
     AND s.confidence = 'ASK_ONLY' AND s.fmv_usd = est.fmv_usd
     AND COALESCE(s.algo_version, '') !~ '_(compcap|bidpull|tiercap)'
)
INSERT INTO public.audit_20261127_topshot_unsold_tiercap_backup
  (edition_id, snapshot_id, old_fmv_usd, new_fmv_usd, estimate_usd, old_algo_version, new_algo_version)
SELECT edition_id, snapshot_id, old_fmv, new_fmv, est, algo_version,
       COALESCE(algo_version, '') || CASE WHEN bid IS NOT NULL AND new_fmv <= round(bid, 2) THEN '_tiercap_bidfloor' ELSE '_tiercap' END
  FROM calc
 WHERE new_fmv < old_fmv
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd, algo_version = b.new_algo_version
  FROM public.audit_20261127_topshot_unsold_tiercap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261127_topshot_unsold_tiercap_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261127_topshot_unsold_tiercap', 'nba_top_shot', e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261127_topshot_unsold_tiercap_backup b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261127_topshot_unsold_tiercap_backup;
  IF n > 200 THEN
    RAISE EXCEPTION 'tier-cap re-stamp touched % editions; the dry run found 88', n;
  END IF;
END
$mig$;
