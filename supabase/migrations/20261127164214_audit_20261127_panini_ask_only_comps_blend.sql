-- 2026-11-27 (Claude Code cloud; Trevor: "The asking price shouldn't really matter. We need to come up with a predictive
-- fmv for this, based upon what we've seen elsewhere" -> chose the blend). Panini ASK_ONLY FMV becomes a blend of the
-- ask rule and a SAME-CARD COMPARABLES estimate. Write-up: docs/proposals/panini-predictive-fmv-for-unsold-editions-2026-11-27.md
--
-- WHY. A never-sold Panini edition was priced at its floor ask x 0.5 (PANINI_ASK_ONLY_MULT). One wish-priced listing set
-- the number: the Rolling Stones Behind the Scenes Prizms Black Finite 1/1 (packcard-2130_415553_3) read $984 off a
-- $1,968 ask while its own /99 Silver sells for ~$3.
--
-- MODEL. A card = product_set_id + player_name + card number (external_id's last segment). The anchor is the card's most
-- common printing with a sale in 365 days, priced at its 365-day median. estimate = anchor x exp(a_b + beta_b x
-- ln(anchor_mint / mint)), fitted per target-mint bucket on 24,392 real-sale pairs (never on FMV). The 1/1 bucket's
-- intercept carries the 1-of-1 premium a single power law missed (x2.75).
-- PUBLISHED = least( sqrt(ask_rule x estimate), 2 x ask_rule ), i.e. never above the live ask.
--
-- BACKTEST (n 1,035 ASK_ONLY editions' FIRST sales, last 60 days; anchors priced only from sales before that sale):
--   MdAE |ln| 0.693 -> 0.558; within +/-25 % 20.2 -> 23.2 %; WAPE 0.954 -> 0.601. Comparables alone lost (0.777), which
--   the write-up explains: first sales are often buys AT the ask, and over-asked cards never sell into the sample.
--
-- TAGS. A price moved DOWN is tagged `_compcap` (the existing suffix: lib/fmv-basis.ts reads it as "comparables" and the
-- note "held to an estimate from similar editions in the same set"); a price moved UP is tagged `_compblend`.
--
-- RE-STAMP. Today's ASK_ONLY editions whose latest snapshot is the current price are re-priced the same way, backed up
-- in public.audit_20261127_panini_ask_only_comps_backup, and written to fmv_restatements so the market-cap 7-day
-- change does not read the rule change as a market move.
--
-- anon-exec: revoked (panini_comps_estimate, fmv_snapshots_blend_panini_ask_only_to_comps) — new functions; revoked from PUBLIC, anon, authenticated, granted to service_role below.
--
-- REVERT: DROP TRIGGER fmv_snapshots_blend_panini_ask_only_to_comps_trg ON public.fmv_snapshots;
--   UPDATE public.fmv_snapshots fs SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261127_panini_ask_only_comps_backup b WHERE fs.id = b.snapshot_id AND fs.fmv_usd = b.new_fmv_usd;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd, refreshed_at = now()
--     FROM public.audit_20261127_panini_ask_only_comps_backup b WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;
--   DELETE FROM public.fmv_restatements WHERE source = 'audit_20261127_panini_ask_only_comps_blend';

CREATE OR REPLACE FUNCTION public.panini_comps_estimate(p_external_id text)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH t AS (
    SELECT pe.product_set_id, pe.player_name, pe.mint_cap, substring(pe.external_id from '_([0-9]+)$') AS card_no
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
  )
  SELECT round((a.ap * exp(
           CASE WHEN t.mint_cap = 1   THEN  1.318 + 0.496 * ln(a.amint::numeric / t.mint_cap)
                WHEN t.mint_cap <= 5  THEN  0.102 + 0.523 * ln(a.amint::numeric / t.mint_cap)
                WHEN t.mint_cap <= 10 THEN  0.362 + 0.558 * ln(a.amint::numeric / t.mint_cap)
                WHEN t.mint_cap <= 25 THEN  0.597 + 0.417 * ln(a.amint::numeric / t.mint_cap)
                WHEN t.mint_cap <= 99 THEN  0.338 + 0.137 * ln(a.amint::numeric / t.mint_cap)
                ELSE                       -0.049 + 0.077 * ln(a.amint::numeric / t.mint_cap) END))::numeric, 2)
    FROM t, a
   WHERE a.ap > 0;
$function$;
REVOKE ALL ON FUNCTION public.panini_comps_estimate(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_comps_estimate(text) TO service_role;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_blend_panini_ask_only_to_comps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_xid  text;
  v_pred numeric;
  v_new  numeric;
BEGIN
  IF NEW.collection_id = c_panini
     AND NEW.confidence = 'ASK_ONLY'
     AND NEW.fmv_usd > 0
     AND NEW.edition_id IS NOT NULL
     AND COALESCE(NEW.algo_version, '') !~ '_comp(cap|blend)'
  THEN
    SELECT e.external_id INTO v_xid FROM public.editions e WHERE e.id = NEW.edition_id;
    IF v_xid IS NOT NULL THEN
      v_pred := public.panini_comps_estimate(v_xid);
      IF v_pred > 0 THEN
        v_new := round(least(sqrt(NEW.fmv_usd * v_pred), 2 * NEW.fmv_usd), 2);
        IF v_new < NEW.fmv_usd THEN
          NEW.fmv_usd := v_new;
          NEW.algo_version := COALESCE(NEW.algo_version, '') || '_compcap';
        ELSIF v_new > NEW.fmv_usd THEN
          NEW.fmv_usd := v_new;
          NEW.algo_version := COALESCE(NEW.algo_version, '') || '_compblend';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fmv_snapshots_blend_panini_ask_only_to_comps() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fmv_snapshots_blend_panini_ask_only_to_comps() TO service_role;
COMMENT ON FUNCTION public.fmv_snapshots_blend_panini_ask_only_to_comps() IS
  'BEFORE INSERT on fmv_snapshots (2026-11-27): a Panini ASK_ONLY fmv_usd (floor ask x 0.5) becomes least(sqrt(that x panini_comps_estimate(edition)), the live ask) when the card has a sold same-card printing. Down = _compcap, up = _compblend.';

DROP TRIGGER IF EXISTS fmv_snapshots_blend_panini_ask_only_to_comps_trg ON public.fmv_snapshots;
CREATE TRIGGER fmv_snapshots_blend_panini_ask_only_to_comps_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_blend_panini_ask_only_to_comps();

CREATE TABLE IF NOT EXISTS public.audit_20261127_panini_ask_only_comps_backup (
  edition_id uuid PRIMARY KEY,
  snapshot_id uuid,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  estimate_usd numeric NOT NULL,
  old_algo_version text,
  new_algo_version text,
  restamped_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261127_panini_ask_only_comps_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261127_panini_ask_only_comps_backup FROM PUBLIC, anon, authenticated;

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
INSERT INTO public.audit_20261127_panini_ask_only_comps_backup
  (edition_id, snapshot_id, old_fmv_usd, new_fmv_usd, estimate_usd, old_algo_version, new_algo_version)
SELECT edition_id, snapshot_id, old_fmv, new_fmv, pred, algo_version,
       COALESCE(algo_version, '') || CASE WHEN new_fmv < old_fmv THEN '_compcap' ELSE '_compblend' END
  FROM calc
 WHERE new_fmv <> old_fmv
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd, algo_version = b.new_algo_version
  FROM public.audit_20261127_panini_ask_only_comps_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261127_panini_ask_only_comps_backup b
 WHERE c.edition_id = b.edition_id
   AND c.confidence = 'ASK_ONLY'
   AND c.fmv_usd = b.old_fmv_usd;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261127_panini_ask_only_comps_blend', 'panini_blockchain', e.external_id, b.old_fmv_usd, b.new_fmv_usd, now()
  FROM public.audit_20261127_panini_ask_only_comps_backup b
  JOIN public.editions e ON e.id = b.edition_id
ON CONFLICT (source, collection_slug, ext_id) DO NOTHING;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261127_panini_ask_only_comps_backup;
  IF n < 1500 OR n > 2900 THEN
    RAISE EXCEPTION 'Panini comps blend re-priced % editions; expected ~2,000-2,600 of the 2,611 anchored ASK_ONLY (11-27)', n;
  END IF;
END
$mig$;