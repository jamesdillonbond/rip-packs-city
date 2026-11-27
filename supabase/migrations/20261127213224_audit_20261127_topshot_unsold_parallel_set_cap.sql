-- audit_20261127_topshot_unsold_parallel_set_cap
--
-- 2026-11-27 (Claude Code cloud; Trevor: "Figure out what makes sense as fmv for that moment").
--
-- THE CASE: Memphis Grizzlies Fit Check (Diced) /10 (102:3907::8) published $315 = 0.9 x one holder's $350 ask. It has
-- never sold. Its own play's other printings sit at $4-$5 (Standard /165, ::5 /25, Bit /50), and the 29 other Fit Check
-- Diced /10 editions (one per team) sold 11 times in the last year: per-edition medians $8.50-$99, median $40, the Memphis
-- Standard trading like every other team's (~$6). The comparables model (comp-1.1) could not see them — it only uses
-- editions whose CURRENT FMV is HIGH/MEDIUM/LOW, and old Diced sales leave those editions ASK_ONLY. What makes sense:
-- ~$40, what the same parallel of the same set sells for.
--
-- RULE (new BEFORE INSERT trigger on fmv_snapshots): Top Shot, ASK_ONLY, a PARALLEL edition (external_id ::N), tier not
-- LEGENDARY/ULTIMATE (20261127184110's _tiercap owns those), circulation <> 1 (no estimate for a 1/1), never sold
-- (no sales_market row), not already _compcap/_bidpull/_tiercap:
--   price := least(price, greatest(median 365-day sale of OTHER editions in the same set_id + parallel (>= 3 editions),
--                                  best open edition/subedition offer))
-- tagged "_parcap_compcap" ("_parcap_compcap_bidfloor" when the offer set it). The suffix ENDS in _compcap on purpose:
-- lib/fmv-basis.ts (askCapFlag, priceRuleNotes) and get_edition_detail's basis_comparables already read that as "held to
-- an estimate from similar editions in the same set", which is exactly this rule; "_parcap" keeps the arm separable.
--
-- BACKTEST (point in time — only sales before each first sale; Top Shot parallel first sales 2026-07-08..11-27 whose
-- last snapshot in the 7 days before was a plain ASK_ONLY, >= 3 comparable editions), sales_market:
--   Common/Fandom/Rare, n = 319:  published MdAE 0.693, bias -0.683 (published ~2x the sale), within +/-25 % 22 %,
--                                 published > 2x the sale 49 %;  this rule MdAE 0.452, bias -0.077, within +/-25 % 30 %,
--                                 > 2x 18 %, sale > 2x the price 16 % (was 1 %).
--   After the 11-13 comparables/offer steps only (n = 49): MdAE 0.642 -> 0.511, bias -0.642 -> -0.118.
--   Tried and rejected: least(pub, 1.5 x median) MdAE 0.484 bias -0.343; geometric mean MdAE 0.515 bias -0.305;
--   0.40 x price floor (the L/U rule's) MdAE 0.452 bias -0.145 with 23 % > 2x.
-- DRY RUN at ship: 8 editions eligible, all lowered, $2,537 -> $460 (Fit Check (Diced) $315 -> $40; its best offer is $10).
-- The 365-day medians live in public.topshot_unsold_parallel_comps, refreshed twice a day (~170k buffers, ~25 s cold).
-- FORWARD TEST: topshot_ask_only_forward_test() buckets these under 'compcap' (suffix match); split by '_parcap' to read
-- this arm alone.
--
-- anon-exec: revoked (refresh_topshot_unsold_parallel_comps, fmv_snapshots_parallel_cap_topshot_unsold) — new functions; revoked from PUBLIC, anon, authenticated below.
--
-- REVERT: DROP TRIGGER fmv_snapshots_tier_cap_topshot_unsold_parallel_trg ON public.fmv_snapshots;
--   SELECT cron.unschedule('rpc-topshot-unsold-parallel-comps');
--   UPDATE public.fmv_snapshots fs SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261127_topshot_unsold_parcap_backup b WHERE fs.id = b.snapshot_id AND fs.fmv_usd = b.new_fmv_usd;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd, refreshed_at = now()
--     FROM public.audit_20261127_topshot_unsold_parcap_backup b WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
--   DELETE FROM public.fmv_restatements WHERE source = 'audit_20261127_topshot_unsold_parcap';

CREATE TABLE IF NOT EXISTS public.topshot_unsold_parallel_comps (
  set_id text NOT NULL,
  parallel text NOT NULL,
  est_usd numeric NOT NULL,
  n_editions int NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (set_id, parallel)
);
ALTER TABLE public.topshot_unsold_parallel_comps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_unsold_parallel_comps FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_topshot_unsold_parallel_comps()
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
    INSERT INTO public.topshot_unsold_parallel_comps (set_id, parallel, est_usd, n_editions, computed_at)
    SELECT e.set_id::text, split_part(e.external_id, '::', 2),
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.price_usd)::numeric, 2),
           count(DISTINCT e.id)::int, v_now
      FROM public.editions e
      JOIN public.sales_market m ON m.edition_id = e.id
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
       AND e.set_id IS NOT NULL
       AND m.collection_id = e.collection_id
       AND m.price_usd > 0
       AND m.sold_at > now() - interval '365 days'
     GROUP BY 1, 2
    HAVING percentile_cont(0.5) WITHIN GROUP (ORDER BY m.price_usd) > 0
    ON CONFLICT (set_id, parallel) DO UPDATE
      SET est_usd = EXCLUDED.est_usd, n_editions = EXCLUDED.n_editions, computed_at = EXCLUDED.computed_at;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    -- write first, then retire only what this run did not write
    IF v_written > 0 THEN
      DELETE FROM public.topshot_unsold_parallel_comps WHERE computed_at < v_now;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    END IF;
  -- a statement_timeout kill (57014) is not in OTHERS; name it so the run record below still sees it. The tail is
  -- one bounded INSERT, and the error is re-raised after it.
  EXCEPTION WHEN query_canceled OR others THEN
    v_err := SQLERRM;
  END;

  BEGIN
    INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, duration_ms, rows_found, rows_written, ok, error, extra)
    VALUES ('topshot-unsold-parallel-comps', 'nba_top_shot', v_now, clock_timestamp(),
            round(EXTRACT(EPOCH FROM (clock_timestamp() - v_now)) * 1000)::int, v_written, v_written,
            v_err IS NULL AND v_written > 0, COALESCE(v_err, CASE WHEN v_written = 0 THEN 'no set/parallel rows computed' END),
            jsonb_build_object('deleted', v_deleted));
  -- when-others-timeout-blind: intentional — the run record must not fail the refresh it records.
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION 'refresh_topshot_unsold_parallel_comps: %', v_err;
  END IF;
  RETURN jsonb_build_object('ok', v_written > 0, 'written', v_written, 'deleted', v_deleted);
END
$function$;
REVOKE ALL ON FUNCTION public.refresh_topshot_unsold_parallel_comps() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_unsold_parallel_comps() TO service_role;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_parallel_cap_topshot_unsold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tier text;
  v_ext text;
  v_set text;
  v_circ int;
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
    SELECT e.tier::text, e.external_id, e.set_id::text, e.circulation_count
      INTO v_tier, v_ext, v_set, v_circ
      FROM public.editions e WHERE e.id = NEW.edition_id;
    IF v_ext ~ '^[0-9]+:[0-9]+::[0-9]+$'
       AND v_tier NOT IN ('LEGENDARY', 'ULTIMATE')
       AND COALESCE(v_circ, 0) <> 1
       AND NOT EXISTS (SELECT 1 FROM public.sales_market s WHERE s.edition_id = NEW.edition_id)
    THEN
      SELECT c.est_usd INTO v_est
        FROM public.topshot_unsold_parallel_comps c
       WHERE c.set_id = v_set AND c.parallel = split_part(v_ext, '::', 2)
         AND c.n_editions >= 3
         AND c.computed_at > now() - interval '2 days';
      IF v_est IS NOT NULL AND v_est > 0 THEN
        SELECT max(o.offer_amount_usd) INTO v_bid
          FROM public.offers o
         WHERE o.collection_id = NEW.collection_id
           AND o.edition_id = NEW.edition_id
           AND o.status = 'open'
           AND o.offer_type IN ('edition', 'subedition')
           AND (o.expires_at IS NULL OR o.expires_at > now());
        v_new := round(least(NEW.fmv_usd, greatest(v_est, COALESCE(v_bid, 0))), 2);
        IF v_new < NEW.fmv_usd THEN
          NEW.fmv_usd := v_new;
          IF v_bid IS NOT NULL AND v_new <= round(v_bid, 2) THEN
            NEW.algo_version := COALESCE(NEW.algo_version, '') || '_parcap_compcap_bidfloor';
          ELSE
            NEW.algo_version := COALESCE(NEW.algo_version, '') || '_parcap_compcap';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fmv_snapshots_parallel_cap_topshot_unsold() FROM PUBLIC, anon, authenticated;

-- Name sorts after fmv_snapshots_pull_topshot_thin_to_best_offer_trg (so a _bidpull row is skipped) and just before
-- fmv_snapshots_tier_cap_topshot_unsold_trg (disjoint tiers).
DROP TRIGGER IF EXISTS fmv_snapshots_tier_cap_topshot_unsold_parallel_trg ON public.fmv_snapshots;
CREATE TRIGGER fmv_snapshots_tier_cap_topshot_unsold_parallel_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_parallel_cap_topshot_unsold();

SELECT public.refresh_topshot_unsold_parallel_comps();

SELECT cron.schedule('rpc-topshot-unsold-parallel-comps', '53 2,14 * * *', 'select public.refresh_topshot_unsold_parallel_comps()');

CREATE TABLE IF NOT EXISTS public.audit_20261127_topshot_unsold_parcap_backup (
  edition_id uuid PRIMARY KEY,
  snapshot_id uuid,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  estimate_usd numeric NOT NULL,
  old_algo_version text,
  new_algo_version text,
  restamped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261127_topshot_unsold_parcap_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261127_topshot_unsold_parcap_backup FROM PUBLIC, anon, authenticated;

WITH cur AS (
  SELECT c.edition_id, c.fmv_usd, e.set_id::text AS set_id, split_part(e.external_id, '::', 2) AS par,
         (SELECT max(o.offer_amount_usd) FROM public.offers o
           WHERE o.collection_id = c.collection_id AND o.edition_id = c.edition_id AND o.status = 'open'
             AND o.offer_type IN ('edition', 'subedition') AND (o.expires_at IS NULL OR o.expires_at > now())) AS bid
    FROM public.edition_fmv_current c
    JOIN public.editions e ON e.id = c.edition_id
   WHERE c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND c.confidence = 'ASK_ONLY' AND c.fmv_usd > 0
     AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
     AND e.tier NOT IN ('LEGENDARY', 'ULTIMATE')
     AND COALESCE(e.circulation_count, 0) <> 1
     AND NOT EXISTS (SELECT 1 FROM public.sales_market m WHERE m.edition_id = c.edition_id)
), est AS (
  SELECT cur.*, t.est_usd AS est
    FROM cur
    JOIN public.topshot_unsold_parallel_comps t ON t.set_id = cur.set_id AND t.parallel = cur.par AND t.n_editions >= 3
), snap AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND fs.edition_id IN (SELECT edition_id FROM est)
   ORDER BY fs.edition_id, fs.computed_at DESC
), calc AS (
  SELECT est.edition_id, s.id AS snapshot_id, est.fmv_usd AS old_fmv, est.est, est.bid, s.algo_version,
         round(least(est.fmv_usd, greatest(est.est, COALESCE(est.bid, 0))), 2) AS new_fmv
    FROM est
    JOIN snap s ON s.edition_id = est.edition_id
   WHERE s.confidence = 'ASK_ONLY' AND s.fmv_usd = est.fmv_usd
     AND COALESCE(s.algo_version, '') !~ '_(compcap|bidpull|tiercap)'
)
INSERT INTO public.audit_20261127_topshot_unsold_parcap_backup
  (edition_id, snapshot_id, old_fmv_usd, new_fmv_usd, estimate_usd, old_algo_version, new_algo_version)
SELECT edition_id, snapshot_id, old_fmv, new_fmv, est, algo_version,
       COALESCE(algo_version, '') || CASE WHEN bid IS NOT NULL AND new_fmv <= round(bid, 2) THEN '_parcap_compcap_bidfloor' ELSE '_parcap_compcap' END
  FROM calc
 WHERE new_fmv < old_fmv
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd, algo_version = b.new_algo_version
  FROM public.audit_20261127_topshot_unsold_parcap_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261127_topshot_unsold_parcap_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261127_topshot_unsold_parcap', 'nba_top_shot', e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261127_topshot_unsold_parcap_backup b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261127_topshot_unsold_parcap_backup;
  IF n > 50 THEN
    RAISE EXCEPTION 'parallel-cap re-stamp touched % editions; the dry run found 8', n;
  END IF;
END
$mig$;
