-- DB invariant: public.pinnacle_fmv_recalc_render_all — the Disney Pinnacle FMV
-- writer — plus public.pinnacle_catalog_fmv_history_capture, the AFTER trigger that
-- turns each of its writes into the chart series. They are pinned in ONE file because
-- the defect that motivated the pin lives in their INTERACTION, not in either alone.
--
-- This is a PRICING writer on pg_cron `rpc-pinnacle-fmv-recalc-backstop`
-- (`37 22 * * *`), and it was unpinned until 2026-08-16 because it is NOT SECURITY
-- DEFINER — a sweep scoped to SECDEF functions could not see it. Three of the eleven
-- unpinned scheduled writers found that day were non-SECDEF for the same reason.
--
-- The four properties that decide what a collector is shown:
--   1. an ASK-derived price NEVER overwrites a sales-derived one (the pass is gated on
--      confidence IN STALE/NO_DATA/ASK_ONLY/NULL);
--   2. an absurd floor is REJECTED, not published (floor <= 10000);
--   3. an ASK_ONLY render whose floor DISAPPEARED reverts to NO_DATA with a NULL price —
--      never a stale floor left standing as a current price;
--   4. a render with no confidence at all becomes NO_DATA, so "unpriced" is a stated
--      label rather than a NULL gap a caller has to interpret.
--
-- ⚠ AND THE INTERACTION, WHICH IS A FIXED BUG AND MUST STAY FIXED. `NOW()` is
-- TRANSACTION-STABLE, and this function writes many renders twice in one transaction
-- (the sales loop, then the ASK_ONLY pass), so both revisions carry the IDENTICAL
-- `fmv_computed_at`. The history trigger keys on `(render_id, computed_at)`. While that
-- conflict resolved to DO NOTHING it silently discarded the SECOND — the published —
-- revision for 776 renders, so the edition chart's newest point was a price the page
-- was no longer showing. `20260815172945` changed it to DO UPDATE. Measured live
-- 2026-08-16: renders where the catalog and the newest history point disagree on an
-- ASK_ONLY price = 0, down from 776. The test below reproduces the exact double-write
-- and asserts the SECOND value survives — a revert to DO NOTHING reds it.
--
-- ⚠ SEPARATELY, AND NOT FIXED: the trigger's WHEN clause is `new.fmv_usd IS NOT NULL`,
-- so property 3 above — the de-pricing — is NEVER RECORDED. A render that loses its
-- floor keeps its last price as the newest point in the series forever while the page
-- shows it unpriced. Measured live 2026-08-16: 20 renders in that state, the oldest
-- 54 days. That is the same page-contradicts-chart shape as the fixed bug by a
-- different route. It is pinned as CURRENT BEHAVIOUR because whether a price series
-- should record a de-pricing is a product decision, not a bug fix.
--
-- Both function DDLs below are VERBATIM from their committed migrations, each verified
-- against live prod prosrc (whitespace-collapsed md5) on 2026-08-16.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE public.pinnacle_catalog (
  render_id            text PRIMARY KEY,
  fmv_usd              numeric,
  fmv_wap_usd          numeric,
  fmv_confidence       public.fmv_confidence,
  fmv_sales_count_7d   int,
  fmv_sales_count_30d  int,
  fmv_days_since_sale  int,
  fmv_liquidity_rating int,
  fmv_computed_at      timestamptz,
  fmv_algo_version     text,
  floor_ask            numeric
);

CREATE TABLE public.pinnacle_sales   (render_id text);
CREATE TABLE public.pinnacle_fmv_history (
  render_id           text,
  fmv_usd             numeric,
  fmv_confidence      public.fmv_confidence,
  fmv_sales_count_30d int,
  computed_at         timestamptz,
  PRIMARY KEY (render_id, computed_at)
);

-- Stub for the per-render pricer. Returns whatever a control table says, so the test
-- drives the SWEEP's policy rather than re-testing the pricing model.
CREATE TABLE public._render_price (render_id text primary key, fmv numeric, conf text);
CREATE FUNCTION public.pinnacle_fmv_recalc_render(p_render text) RETURNS json
LANGUAGE sql AS $s$
  SELECT json_build_object('fmv_usd', r.fmv, 'wap_usd', r.fmv, 'confidence', r.conf,
                           'sales_count_7d', 1, 'sales_count_30d', 2,
                           'days_since_sale', 3, 'liquidity_rating', 4)
  FROM public._render_price r WHERE r.render_id = p_render;
$s$;

-- Telemetry stub: the real one is non-fatal by design, and this test is not about it.
CREATE FUNCTION public.log_pipeline_run(text, timestamptz, int, int, int, boolean, text,
                                        text, text, text, jsonb) RETURNS void
LANGUAGE sql AS $s$ SELECT NULL::void $s$;

-- >>> BEGIN verbatim pinnacle_catalog_fmv_history_capture (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_catalog_fmv_history_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.pinnacle_fmv_history (render_id, fmv_usd, fmv_confidence, fmv_sales_count_30d, computed_at)
  VALUES (NEW.render_id, NEW.fmv_usd, NEW.fmv_confidence, NEW.fmv_sales_count_30d, COALESCE(NEW.fmv_computed_at, now()))
  ON CONFLICT (render_id, computed_at) DO UPDATE
    SET fmv_usd             = EXCLUDED.fmv_usd,
        fmv_confidence      = EXCLUDED.fmv_confidence,
        fmv_sales_count_30d = EXCLUDED.fmv_sales_count_30d;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim pinnacle_catalog_fmv_history_capture <<<

-- Trigger WHEN clauses copied verbatim from live pg_get_triggerdef (2026-08-16).
CREATE TRIGGER pinnacle_catalog_fmv_history_upd_trg AFTER UPDATE ON public.pinnacle_catalog
FOR EACH ROW WHEN (((new.fmv_usd IS NOT NULL) AND ((new.fmv_usd IS DISTINCT FROM old.fmv_usd)
  OR (new.fmv_confidence IS DISTINCT FROM old.fmv_confidence))))
EXECUTE FUNCTION public.pinnacle_catalog_fmv_history_capture();

-- >>> BEGIN verbatim pinnacle_fmv_recalc_render_all (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_fmv_recalc_render_all()
 RETURNS json
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count int := 0; v_skipped int := 0; v_ask int := 0; r record; v json; v_started timestamptz := clock_timestamp();
BEGIN
  FOR r IN SELECT DISTINCT render_id FROM pinnacle_sales WHERE render_id IS NOT NULL LOOP
    v := pinnacle_fmv_recalc_render(r.render_id);
    UPDATE public.pinnacle_catalog c
       SET fmv_usd = NULLIF((v->>'fmv_usd'),'')::numeric,
           fmv_wap_usd = NULLIF((v->>'wap_usd'),'')::numeric,
           fmv_confidence = (v->>'confidence')::public.fmv_confidence,
           fmv_sales_count_7d = (v->>'sales_count_7d')::int,
           fmv_sales_count_30d = (v->>'sales_count_30d')::int,
           fmv_days_since_sale = NULLIF((v->>'days_since_sale'),'')::int,
           fmv_liquidity_rating = (v->>'liquidity_rating')::int,
           fmv_computed_at = NOW(),
           fmv_algo_version = 'pinnacle-2.0.0-render'
     WHERE c.render_id = r.render_id;
    IF (v->>'fmv_usd') IS NULL THEN v_skipped := v_skipped + 1; ELSE v_count := v_count + 1; END IF;
  END LOOP;

  -- ASK_ONLY pass: renders with no in-window (30d) sales but a live floor read
  -- as floor × 0.90 (TS parity; LiveToken doesn't cover Pinnacle). Takes
  -- precedence over STALE for stale-sale renders that have a floor.
  -- NULL confidence (never priced) with a floor is included so a live floor is
  -- always surfaced regardless of prior label.
  UPDATE public.pinnacle_catalog c
     SET fmv_usd = ROUND(c.floor_ask * 0.90, 2),
         fmv_confidence = 'ASK_ONLY',
         fmv_computed_at = NOW(),
         fmv_algo_version = 'pinnacle-2.0.0-render-ask'
   WHERE (c.fmv_confidence IN ('STALE','NO_DATA','ASK_ONLY') OR c.fmv_confidence IS NULL)
     AND c.floor_ask > 0 AND c.floor_ask <= 10000;
  GET DIAGNOSTICS v_ask = ROW_COUNT;

  -- Self-correct: an ASK_ONLY render whose floor disappeared (and that the sales
  -- loop did not re-price this run) reverts to NO_DATA — never a stale floor.
  UPDATE public.pinnacle_catalog c
     SET fmv_usd = NULL,
         fmv_confidence = 'NO_DATA',
         fmv_computed_at = NOW(),
         fmv_algo_version = 'pinnacle-2.0.0-render-ask'
   WHERE c.fmv_confidence = 'ASK_ONLY'
     AND (c.floor_ask IS NULL OR c.floor_ask <= 0 OR c.floor_ask > 10000);

  -- Consistency: any render still without a confidence (never in sales, no floor)
  -- is genuinely unpriced -> NO_DATA, not a NULL gap.
  UPDATE public.pinnacle_catalog c
     SET fmv_confidence = 'NO_DATA',
         fmv_computed_at = NOW(),
         fmv_algo_version = 'pinnacle-2.0.0-render-ask'
   WHERE c.fmv_confidence IS NULL;

  PERFORM log_pipeline_run('pinnacle-fmv-recalc', v_started,
    v_count + v_skipped, v_count, v_skipped, true, NULL, 'disney_pinnacle', NULL, NULL,
    json_build_object('renders_priced', v_count, 'renders_no_data', v_skipped, 'renders_ask_only', v_ask)::jsonb);

  RETURN json_build_object('renders_priced', v_count, 'renders_no_data', v_skipped, 'renders_ask_only', v_ask, 'computed_at', NOW());
END;
$function$;
-- <<< END verbatim pinnacle_fmv_recalc_render_all <<<

-- ── Fixture ─────────────────────────────────────────────────────────────────
INSERT INTO public.pinnacle_catalog (render_id, fmv_confidence, floor_ask) VALUES
  ('sold_high',   NULL,       300),   -- sales loop prices it HIGH; has a floor too
  ('sold_stale',  NULL,       100),   -- sales loop prices it STALE; floor -> ASK_ONLY
  ('ask_only',    'NO_DATA',   50),   -- never sold, live floor -> ASK_ONLY
  ('absurd_ask',  'NO_DATA', 99999),  -- floor above the 10000 cap -> must NOT price
  ('lost_floor',  'ASK_ONLY', NULL),  -- was ASK_ONLY, floor gone -> must revert
  ('never_seen',  NULL,      NULL);   -- no sales, no floor -> NO_DATA

INSERT INTO public.pinnacle_sales (render_id) VALUES ('sold_high'), ('sold_stale');
INSERT INTO public._render_price VALUES
  ('sold_high',  180.00, 'HIGH'),
  ('sold_stale',  40.00, 'STALE');

-- Seed a prior price for lost_floor so the revert is observable as a CHANGE.
UPDATE public.pinnacle_catalog SET fmv_usd = 45.00, fmv_computed_at = now() - interval '10 days'
 WHERE render_id = 'lost_floor';

SELECT public.pinnacle_fmv_recalc_render_all();

-- ── 1. An ASK-derived price never overwrites a sales-derived one ────────────
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.pinnacle_catalog WHERE render_id='sold_high'),
  'HIGH', 'a HIGH sales-derived price is NOT overwritten by the ASK_ONLY pass, even though '
  'the render has a live floor — an ask is a listing, not a trade');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.pinnacle_catalog WHERE render_id='sold_high'),
  '180.00', 'and its VALUE is the sales-derived one, not floor * 0.90. ⚠ The floor is 300 '
  '(-> 270.00) DELIBERATELY: at the 200 this fixture first used, floor * 0.90 was exactly '
  '180.00 and the assertion could not tell the two paths apart at all');

-- ── 2. STALE is explicitly IN the overwrite set: a live floor beats a stale trade ──
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.pinnacle_catalog WHERE render_id='sold_stale'),
  'ASK_ONLY', 'a STALE sales price IS superseded by a live floor — the ordering of the two '
  'passes is the policy, and it is deliberate');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.pinnacle_catalog WHERE render_id='sold_stale'),
  '90.00', 'ASK_ONLY is floor * 0.90 (100 -> 90.00), the Top Shot parity haircut');

-- ── 3. An absurd floor is rejected, not published ───────────────────────────
SELECT _assert((SELECT fmv_usd FROM public.pinnacle_catalog WHERE render_id='absurd_ask') IS NULL,
  'a floor above the 10000 cap prices NOTHING — publishing 89999.10 off one silly listing '
  'would put a fabricated headline number on a public page');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.pinnacle_catalog WHERE render_id='absurd_ask'),
  'NO_DATA', 'and it is labelled NO_DATA, so the absence is stated rather than left NULL');

-- ⚠ MUTATION FINDING — THE CAP'S REAL JOB IS UPSTREAM OF THE CATALOG. Removing the cap
-- from the ASK pass leaves the CATALOG identical, because the self-correct pass below
-- reverts any ASK_ONLY render whose floor is out of range: the two guards mask each other
-- and no catalog assertion can tell them apart.
-- What the cap uniquely prevents is a bogus point entering the PRICE CHART. Without it the
-- ASK pass writes 89999.10, which fires the history trigger (its WHEN clause only requires
-- a non-NULL price), and the self-correct pass then NULLs the catalog WITHOUT writing a
-- corrective row — because that same WHEN clause skips de-pricings. So the catalog ends up
-- right and the series keeps an absurd spike forever.
-- That is exactly the property the assertion below pins, and it is the reason the cap must
-- live in the ASK pass rather than only in the self-correct pass.
SELECT _assert_eq((SELECT count(*)::text FROM public.pinnacle_fmv_history WHERE render_id='absurd_ask'),
  '0', 'an absurd floor never reaches the price HISTORY either — the cap stops it before the '
  'trigger sees it. Move the cap and the catalog still self-corrects while the chart keeps a '
  'permanent bogus spike, because a de-pricing writes no corrective point');

-- ── 4. A vanished floor reverts to NO_DATA — never a stale floor left standing ──
SELECT _assert((SELECT fmv_usd FROM public.pinnacle_catalog WHERE render_id='lost_floor') IS NULL,
  'an ASK_ONLY render whose floor disappeared has its PRICE cleared, not carried forward');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.pinnacle_catalog WHERE render_id='lost_floor'),
  'NO_DATA', 'and is relabelled NO_DATA — a delisted item is unpriced, not still worth its last ask');

-- ── 5. No NULL confidence gaps survive the sweep ────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.pinnacle_catalog WHERE fmv_confidence IS NULL),
  '0', 'every render carries a confidence label after the sweep — unpriced is SAID, not implied');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.pinnacle_catalog WHERE render_id='never_seen'),
  'NO_DATA', 'a render with neither sales nor a floor is NO_DATA');

-- ── ⚠ 6. NOW() IS TRANSACTION-STABLE: the double-written render carries ONE timestamp ──
SELECT _assert_eq((SELECT count(DISTINCT fmv_computed_at)::text FROM public.pinnacle_catalog
                    WHERE render_id IN ('sold_high','sold_stale','ask_only')), '1',
  'every render touched in this transaction shares one fmv_computed_at, because NOW() is '
  'transaction-stable — this is the root cause of the history-drop bug, not a coincidence');

-- ── ⚠ 7. THE FIXED BUG: history keeps the SECOND (published) revision ───────
-- sold_stale is written twice in one transaction under one timestamp: STALE 40.00 by the
-- sales loop, then ASK_ONLY 90.00 by the ask pass. The history row must hold the value
-- the page shows. Reverting the trigger's ON CONFLICT to DO NOTHING reds this.
SELECT _assert_eq((SELECT count(*)::text FROM public.pinnacle_fmv_history WHERE render_id='sold_stale'),
  '1', 'one history row for one transaction — the timestamp is the key');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.pinnacle_fmv_history WHERE render_id='sold_stale'),
  '90.00', 'and it holds the SECOND, PUBLISHED revision (90.00), not the superseded 40.00. '
  'DO NOTHING kept the first for 776 renders, so the chart contradicted the page');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.pinnacle_fmv_history WHERE render_id='sold_stale'),
  'ASK_ONLY', 'the confidence label travels with the value it belongs to');

-- ── ⚠ 8. NOT FIXED, PINNED AS CURRENT BEHAVIOUR: a de-pricing is never recorded ──
-- lost_floor went 45.00 -> NULL in this sweep. The trigger's WHEN clause requires
-- new.fmv_usd IS NOT NULL, so no history row is written and the series' newest point
-- stays 45.00 while the page shows the render unpriced. 20 renders are in this state
-- live (oldest 54 days). Changing it means deciding what a price chart should plot for
-- "no longer priced" — a product call, not a bug fix.
-- The seed UPDATE (NULL -> 45.00) DID fire the trigger, so exactly one row exists and it
-- still holds the old price at the old timestamp. The sweep's de-pricing added nothing.
SELECT _assert_eq((SELECT count(*)::text FROM public.pinnacle_fmv_history WHERE render_id='lost_floor'),
  '1', 'only the earlier PRICED write is in history');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.pinnacle_fmv_history WHERE render_id='lost_floor'),
  '45.00', 'the de-pricing writes NO history row, so the series newest point stays 45.00 '
  'forever while the page shows the render unpriced — the same page-contradicts-chart shape '
  'as the bug fixed above, reached by a different route');
SELECT _assert((SELECT max(computed_at) FROM public.pinnacle_fmv_history WHERE render_id='lost_floor')
                 < now() - interval '9 days',
  'and the newest point still carries the OLD timestamp, so nothing about the series hints '
  'that the price was withdrawn');

SELECT '✓ pinnacle_fmv_recalc_render_all invariants pass' AS result;

ROLLBACK;
