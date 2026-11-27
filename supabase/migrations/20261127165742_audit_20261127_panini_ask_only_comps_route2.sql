-- 2026-11-27 (Claude Code cloud; Trevor: "Work through everything still open"). Follow-ups to 20261127164214 (Panini
-- ASK_ONLY comparables blend):
--
-- 1. OUT-OF-SAMPLE CHECK (no change): the bucket parameters refitted only on sales older than 60 days score the
--    1,038 backtest first sales at MdAE 0.553 vs 0.558 in-sample (old rule 0.693); within +/-25 % 24.8 %. The shipped
--    parameters stand.
-- 2. SECOND ROUTE for cards with NO sold same-card printing (241 ASK_ONLY editions left on the ask rule; 109 have >= 3 such sales): the
--    365-day median sale of the SAME PARALLEL (set_name) in the SAME PRODUCT across other subjects, when >= 3 such
--    sales exist. Backtest on the 71 no-anchor first sales: MdAE 0.464 -> 0.379, WAPE 0.826 -> 0.479 for the same blend
--    (least(sqrt(ask rule x estimate), live ask)). panini_comps_estimate falls back to it; the trigger is unchanged.
--    Re-stamp of the newly covered editions, backed up and restated like 20261127164214.
-- 3. FORWARD TEST: panini_comps_forward_test(p_since) scores every Panini first sale after p_since against the price
--    published just before it, split by _comp* tag vs untagged ASK_ONLY. The only instrument that can see over-asked
--    cards (a backtest only sees cards that sold).
--
-- anon-exec: revoked (panini_comps_forward_test) — new function; revoked from PUBLIC, anon, authenticated, granted to service_role below.
-- anon-exec: intentional — CREATE OR REPLACE of an existing signature keeps its live ACL (service_role only, anon false; 20261127164214) (panini_comps_estimate)
--
-- REVERT: re-apply panini_comps_estimate's body from 20261127164214 (prosrc md5 94a68d35f14fea746c500cab9e2d31c9), and
--   restore the re-stamped rows from public.audit_20261127_panini_ask_only_comps_backup2 exactly as 20261127164214's
--   header restores from its backup (fmv_snapshots by snapshot_id, edition_fmv_current by edition_id, and the
--   fmv_restatements rows of source 'audit_20261127_panini_ask_only_comps_route2').

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.panini_comps_estimate(text)'::regprocedure)
     <> '94a68d35f14fea746c500cab9e2d31c9' THEN
    RAISE EXCEPTION 'panini_comps_estimate is not the 20261127164214 body; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.panini_comps_estimate(p_external_id text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH t AS (
    SELECT pe.product_set_id, pe.player_name, pe.set_name, pe.mint_cap, substring(pe.external_id from '_([0-9]+)$') AS card_no
      FROM public.panini_editions pe
     WHERE pe.external_id = p_external_id
       AND pe.mint_cap > 0 AND pe.player_name IS NOT NULL AND pe.product_set_id IS NOT NULL
     LIMIT 1
  ), a AS (
    SELECT o.mint_cap AS amint,
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.amount_usd)
              FROM public.panini_sales s
             WHERE s.edition_external_id = o.external_id
               AND s.sold_at > now() - interval '365 days' AND s.amount_usd > 0) AS ap
      FROM public.panini_editions o, t
     WHERE o.player_name = t.player_name
       AND o.product_set_id = t.product_set_id
       AND substring(o.external_id from '_([0-9]+)$') = t.card_no
       AND o.external_id <> p_external_id
       AND o.mint_cap > 0
       AND EXISTS (SELECT 1 FROM public.panini_sales s2
                    WHERE s2.edition_external_id = o.external_id
                      AND s2.sold_at > now() - interval '365 days' AND s2.amount_usd > 0)
     ORDER BY o.mint_cap DESC, o.external_id
     LIMIT 1
  ), route1 AS (
    SELECT round((a.ap * exp(
             CASE WHEN t.mint_cap = 1   THEN  1.318 + 0.496 * ln(a.amint::numeric / t.mint_cap)
                  WHEN t.mint_cap <= 5  THEN  0.102 + 0.523 * ln(a.amint::numeric / t.mint_cap)
                  WHEN t.mint_cap <= 10 THEN  0.362 + 0.558 * ln(a.amint::numeric / t.mint_cap)
                  WHEN t.mint_cap <= 25 THEN  0.597 + 0.417 * ln(a.amint::numeric / t.mint_cap)
                  WHEN t.mint_cap <= 99 THEN  0.338 + 0.137 * ln(a.amint::numeric / t.mint_cap)
                  ELSE                       -0.049 + 0.077 * ln(a.amint::numeric / t.mint_cap) END))::numeric, 2) AS est
      FROM t, a
     WHERE a.ap > 0
  ), route2 AS (
    SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.amount_usd)::numeric, 2) AS est, count(*) AS n
      FROM t
      JOIN public.panini_editions o ON o.product_set_id = t.product_set_id AND o.set_name = t.set_name
      JOIN public.panini_sales s ON s.edition_external_id = o.external_id
     WHERE o.external_id <> p_external_id
       AND t.set_name IS NOT NULL
       AND s.sold_at > now() - interval '365 days' AND s.amount_usd > 0
  )
  SELECT COALESCE((SELECT est FROM route1),
                  (SELECT est FROM route2 WHERE n >= 3 AND est > 0));
$function$;

CREATE OR REPLACE FUNCTION public.panini_comps_forward_test(p_since timestamptz DEFAULT '2026-11-27 16:42:14+00')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH fs AS (
    SELECT s.edition_external_id AS xid, min(s.sold_at) AS t0
      FROM public.panini_sales s
     WHERE s.amount_usd > 0
     GROUP BY 1
    HAVING min(s.sold_at) > p_since
  ), sc AS (
    SELECT fs.xid,
           (SELECT s.amount_usd FROM public.panini_sales s WHERE s.edition_external_id = fs.xid AND s.sold_at = fs.t0 LIMIT 1) AS actual,
           sn.fmv_usd AS pub,
           CASE WHEN sn.algo_version ~ '_comp(cap|blend)' THEN 'comps' ELSE 'ask_rule' END AS arm
      FROM fs
      JOIN public.editions e ON e.external_id = fs.xid AND e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
      JOIN LATERAL (SELECT x.fmv_usd, x.confidence, x.algo_version FROM public.fmv_snapshots x
                     WHERE x.edition_id = e.id AND x.computed_at < fs.t0 AND x.fmv_usd > 0
                     ORDER BY x.computed_at DESC LIMIT 1) sn ON sn.confidence = 'ASK_ONLY'
  )
  SELECT COALESCE(jsonb_object_agg(arm, j), '{}'::jsonb)
    FROM (SELECT arm, jsonb_build_object(
                   'n', count(*),
                   'mdae', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(ln(actual / pub)))::numeric, 3),
                   'within_25pct', round(avg((abs(ln(actual / pub)) <= ln(1.25))::int)::numeric, 3),
                   'wape', round((sum(abs(actual - pub)) / NULLIF(sum(actual), 0))::numeric, 3)) AS j
            FROM sc WHERE actual > 0 GROUP BY arm) z;
$function$;
REVOKE ALL ON FUNCTION public.panini_comps_forward_test(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_comps_forward_test(timestamptz) TO service_role;

CREATE TABLE IF NOT EXISTS public.audit_20261127_panini_ask_only_comps_backup2 (
  edition_id uuid PRIMARY KEY,
  snapshot_id uuid,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  estimate_usd numeric NOT NULL,
  old_algo_version text,
  new_algo_version text,
  restamped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261127_panini_ask_only_comps_backup2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261127_panini_ask_only_comps_backup2 FROM PUBLIC, anon, authenticated;

WITH cur AS (
  SELECT c.edition_id, c.fmv_usd, e.external_id
    FROM public.edition_fmv_current c
    JOIN public.editions e ON e.id = c.edition_id
   WHERE c.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND c.confidence = 'ASK_ONLY' AND c.fmv_usd > 0
), est AS (
  SELECT cur.*, public.panini_comps_estimate(cur.external_id) AS pred FROM cur
), snap AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.id, fs.fmv_usd, fs.algo_version, fs.confidence
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     AND fs.edition_id IN (SELECT edition_id FROM est WHERE pred > 0)
   ORDER BY fs.edition_id, fs.computed_at DESC
), calc AS (
  SELECT est.edition_id, s.id AS snapshot_id, est.fmv_usd AS old_fmv, est.pred, s.algo_version,
         round(least(sqrt(est.fmv_usd * est.pred), 2 * est.fmv_usd), 2) AS new_fmv
    FROM est
    JOIN snap s ON s.edition_id = est.edition_id
   WHERE est.pred > 0
     AND s.confidence = 'ASK_ONLY' AND s.fmv_usd = est.fmv_usd
     AND COALESCE(s.algo_version, '') !~ '_comp(cap|blend)'
)
INSERT INTO public.audit_20261127_panini_ask_only_comps_backup2
  (edition_id, snapshot_id, old_fmv_usd, new_fmv_usd, estimate_usd, old_algo_version, new_algo_version)
SELECT edition_id, snapshot_id, old_fmv, new_fmv, pred, algo_version,
       COALESCE(algo_version, '') || CASE WHEN new_fmv < old_fmv THEN '_compcap' ELSE '_compblend' END
  FROM calc
 WHERE new_fmv <> old_fmv
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd, algo_version = b.new_algo_version
  FROM public.audit_20261127_panini_ask_only_comps_backup2 b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261127_panini_ask_only_comps_backup2 b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261127_panini_ask_only_comps_route2', 'panini_blockchain', e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261127_panini_ask_only_comps_backup2 b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261127_panini_ask_only_comps_backup2;
  IF n > 400 THEN
    RAISE EXCEPTION 'route-2 re-stamp touched % editions; expected at most the 241 left uncovered by 20261127164214', n;
  END IF;
END
$mig$;