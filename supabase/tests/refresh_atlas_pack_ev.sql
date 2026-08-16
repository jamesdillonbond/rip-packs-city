-- DB invariant: public.refresh_atlas_pack_ev — pg_cron `rpc-atlas-pack-ev`
-- @ `25 * * * *`.
--
-- WHAT IT DOES. Hourly, for every Top Shot distribution whose drop pool came
-- from ATLAS, it computes pack EV against the current secondary ask and appends
-- a row to `pack_ev_history` — the table behind `pack_ev_latest` and the PUBLIC
-- **+EV** badge.
--
-- ⚠ WHY THE STAKES ARE HIGH. `is_positive_ev` is the single boolean a collector
-- reads as "buying this pack is worth it". CLAUDE.md records that a depleted
-- Top Shot pool prices at 40-86x, and that a green +EV badge on an unfurl is a
-- BUY SIGNAL reaching people who never open the page. Every guard below is an
-- honesty guard, not an optimisation.
--
-- ── THE PROPERTIES ─────────────────────────────────────────────────────────
--
--   1. ⚠ `is_positive_ev` requires `r.lowest_ask > 0`. **A pack whose price we
--      do not know can never be published as +EV** — the claim is about a
--      MARGIN, and there is no margin without a price.
--      ⚠ On the success path with no ask the flag is **NULL, not FALSE**
--      (`NULL > 0` is NULL, and `NULL AND NULL` is NULL) — while the FAILURE
--      branch writes a literal false. Safe for the badge either way, but a
--      consumer hunting negative-EV packs with `is_positive_ev = false` misses
--      every ask-less pack. Both values are pinned below.
--   2. ⚠ `value_ratio` is NULL when there is no ask, never a fabricated number.
--      A ratio against an absent price is UNDEFINED, not enormous — the `|| 1`
--      divide-by-zero class CLAUDE.md documents on the profile page.
--   3. ⚠ `pack_ev` is `gross_ev - COALESCE(lowest_ask, 0)`, so an ask-less pack
--      still gets a positive-looking `pack_ev` equal to its gross EV. That is
--      deliberate, and it is exactly why property 1 lives on a SEPARATE column:
--      `pack_ev` is an arithmetic result, `is_positive_ev` is the CLAIM.
--      Anything rendering a buy signal must read the FLAG, never the sign of
--      pack_ev. Asserted directly, because the two disagreeing looks like a bug
--      to anyone who has not read this.
--   4. ⚠ A FAILED EV COMPUTATION STILL WRITES A ROW — gross 0, typical NULL,
--      `is_positive_ev` FALSE, depletion 100. Skipping would leave the previous
--      hour as `pack_ev_latest`, so a pack that stopped being computable would
--      keep publishing a STALE +EV badge indefinitely. Note
--      `(ev->>'ok')::boolean IS NOT TRUE` — a NULL `ok` takes the failure branch
--      rather than falling through as success.
--   5. `price_source` is 'secondary' or 'none' and `primary_available` is
--      hard-false: the Atlas pool is secondary-market, so the row never implies
--      a primary drop price exists.
--   6. The ask join requires `is_listed IS TRUE AND lowest_ask > 0` — a delisted
--      pack or a zero ask means NO ASK, not a $0 pack. Getting this wrong would
--      make every unlisted pack look infinitely +EV.
--   7. `LEAST(edition_count, 32767)` — the column is smallint; without the clamp
--      a large pool raises 22003 and aborts the whole hourly sweep, taking every
--      other distribution down with it.
--   8. `GREATEST(COALESCE(number_of_pack_slots, 1), 1)` — CLAUDE.md records that
--      slot coverage is only ~83 percent on Top Shot, so the COALESCE is
--      load-bearing, not defensive noise.
--   9. Scoped to `pool_source = 'atlas'` and to the Top Shot collection_id.
--
-- ⚠ RECORDED, NOT FIXED — A FAILED SWEEP IS INVISIBLE. The `EXCEPTION WHEN
-- OTHERS` handler returns `{ok:false}` without re-raising and without logging;
-- `log_pipeline_run` is only reached on the success path, and the cron discards
-- the return value. So a failure leaves NO pipeline_runs row, indistinguishable
-- from "never scheduled" — the same defect as the AllDay/Golazos badge
-- refreshers and the trust-precompute legs. And since PostgreSQL excludes
-- QUERY_CANCELED from OTHERS, a `statement_timeout = 120s` kill never even
-- reaches the handler. The test pins the SUCCESS-path logging so that, if the
-- handler is ever reworked, the working half is protected.
--
-- ⚠ `compute_pack_ev_per_edition_weighted` below is a TEST STAND-IN, not the
-- real function — that one has its own pin. It returns whatever the fixture
-- table tells it to, so the failure branch and the smallint clamp are reachable,
-- and it RECORDS the slots/ask it was handed so the input guards are assertable.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816050000_audit_20260816_snapshot_refresh_atlas_pack_ev.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 acbe79769403d75542bf17f1550959a9).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_drop_pool (
  collection_id uuid,
  dist_id       text,
  pool_source   text
);

CREATE TABLE public.pack_distributions (
  collection_id uuid,
  dist_id       text,
  title         text,
  metadata      jsonb
);

CREATE TABLE public.pack_ask_state (
  collection_slug text,
  dist_id         text,
  is_listed       boolean,
  lowest_ask      numeric
);

CREATE TABLE public.pack_ev_history (
  pack_listing_id      text,
  collection_id        uuid,
  dist_id              text,
  pack_name            text,
  pack_price           numeric,
  primary_price        numeric,
  secondary_ask        numeric,
  price_source         text,
  primary_available    boolean,
  secondary_available  boolean,
  gross_ev             numeric,
  typical_ev           numeric,
  pack_ev              numeric,
  is_positive_ev       boolean,
  value_ratio          numeric,
  fmv_coverage_pct     smallint,
  edition_count        smallint,
  total_unopened       int,
  depletion_pct        numeric,
  snapshotted_at       timestamptz
);

CREATE TABLE public.pipeline_runs (
  pipeline        text,
  started_at      timestamptz,
  finished_at     timestamptz DEFAULT now(),
  rows_found      int,
  rows_written    int,
  rows_skipped    int,
  ok              boolean,
  error           text,
  collection_slug text,
  cursor_before   text,
  cursor_after    text,
  extra           jsonb
);

CREATE FUNCTION public.log_pipeline_run(
  p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text,
  p_cursor_before text, p_cursor_after text, p_extra jsonb
) RETURNS void LANGUAGE sql AS $log$
  INSERT INTO public.pipeline_runs (pipeline, started_at, rows_found, rows_written, rows_skipped,
                                    ok, error, collection_slug, cursor_before, cursor_after, extra)
  VALUES (p_pipeline, p_started_at, p_rows_found, p_rows_written, p_rows_skipped,
          p_ok, p_error, p_collection_slug, p_cursor_before, p_cursor_after, p_extra);
$log$;

CREATE TABLE public.__ev_fixture (
  dist_id    text PRIMARY KEY,
  payload    jsonb,
  seen_slots int,
  seen_ask   numeric
);

CREATE FUNCTION public.compute_pack_ev_per_edition_weighted(
  p_cid uuid, p_dist text, p_ask numeric, p_slots int
) RETURNS jsonb LANGUAGE plpgsql AS $ev$
BEGIN
  UPDATE public.__ev_fixture SET seen_slots = p_slots, seen_ask = p_ask WHERE dist_id = p_dist;
  RETURN (SELECT payload FROM public.__ev_fixture WHERE dist_id = p_dist);
END $ev$;

-- >>> BEGIN verbatim refresh_atlas_pack_ev (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_atlas_pack_ev()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r record;
  ev jsonb;
  v_gross numeric;
  v_typical numeric;
  v_written int := 0;
  v_now timestamptz := now();
BEGIN
  FOR r IN
    SELECT DISTINCT p.dist_id,
           pd.metadata->>'uuid' AS listing_uuid,
           COALESCE(pd.title, pd.metadata->>'name') AS title,
           GREATEST(COALESCE((pd.metadata->>'number_of_pack_slots')::int, 1), 1) AS slots,
           pas.lowest_ask
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = p.dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE p.collection_id = v_cid AND p.pool_source = 'atlas'
  LOOP
    ev := public.compute_pack_ev_per_edition_weighted(v_cid, r.dist_id, COALESCE(r.lowest_ask, 0), r.slots);
    IF (ev->>'ok')::boolean IS NOT TRUE THEN
      INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
        primary_price, secondary_ask, price_source, primary_available, secondary_available,
        gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
      VALUES (r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask,0),
        NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
        false, r.lowest_ask > 0, 0, NULL, 0, false, NULL, NULL, 0, 0, 100, v_now);
      v_written := v_written + 1;
      CONTINUE;
    END IF;
    v_gross := (ev->>'gross_ev')::numeric;
    v_typical := (ev->>'typical_pull_ev')::numeric;
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
      primary_price, secondary_ask, price_source, primary_available, secondary_available,
      gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
    VALUES (
      r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask, 0),
      NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
      false, r.lowest_ask > 0,
      v_gross, v_typical,
      round(v_gross - COALESCE(r.lowest_ask, 0), 2),
      (r.lowest_ask > 0 AND (v_gross - r.lowest_ask) > 0),
      CASE WHEN r.lowest_ask > 0 THEN round(v_gross / r.lowest_ask, 3) ELSE NULL END,
      (ev->>'fmv_coverage_pct')::smallint, LEAST((ev->>'edition_count')::int, 32767), 0, NULL, v_now);
    v_written := v_written + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, v_written, 0, true, NULL,
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', v_written));
  RETURN jsonb_build_object('ok', true, 'written', v_written, 'finished_at', now());
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'written', v_written);
END;
$function$;
-- <<< END verbatim refresh_atlas_pack_ev <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''

-- D-ASK      : listed with a real ask, EV above it        -> +EV published
-- D-UNDER    : listed, EV BELOW the ask                   -> flag false
-- D-NOASK    : no ask row at all                          -> flag false, ratio NULL
-- D-DELISTED : ask row present but is_listed = false      -> treated as NO ASK
-- D-ZEROASK  : ask row present, lowest_ask = 0            -> treated as NO ASK
-- D-FAIL     : EV engine returns ok:false                 -> sentinel row
-- D-NULLOK   : EV engine returns a payload with NO 'ok'   -> sentinel row
-- D-BIG      : edition_count 90000, past the smallint cap -> clamped
-- D-NOSLOTS  : metadata has no number_of_pack_slots       -> slots floor 1
-- D-NOTATLAS : pool_source = 'live'                       -> not swept
-- D-WRONGC   : another collection                         -> not swept
INSERT INTO public.pack_drop_pool (collection_id, dist_id, pool_source) VALUES
  (:TS::uuid, 'D-ASK',      'atlas'),
  (:TS::uuid, 'D-UNDER',    'atlas'),
  (:TS::uuid, 'D-NOASK',    'atlas'),
  (:TS::uuid, 'D-DELISTED', 'atlas'),
  (:TS::uuid, 'D-ZEROASK',  'atlas'),
  (:TS::uuid, 'D-FAIL',     'atlas'),
  (:TS::uuid, 'D-NULLOK',   'atlas'),
  (:TS::uuid, 'D-BIG',      'atlas'),
  (:TS::uuid, 'D-NOSLOTS',  'atlas'),
  (:TS::uuid, 'D-NOTATLAS', 'live'),
  (:AD::uuid, 'D-WRONGC',   'atlas'),
  -- ⚠ D-CROSSPOOL: an atlas pool row under ALL DAY for a dist_id that is
  -- DISTRIBUTED under Top Shot, with no Top Shot pool row. This is the ONLY
  -- shape in which `p.collection_id = v_cid` is load-bearing — the pd join
  -- already pins the distribution's collection, so every other cross-collection
  -- pool row joins to the same tuple and is folded away by SELECT DISTINCT.
  -- Measured live 2026-08-16: 54 dist_ids in pack_drop_pool ALREADY span
  -- collections, and 0 are currently in this exact shape. So the predicate is
  -- redundant TODAY but not structurally — the fixture is a real state the
  -- schema produces, not a contrivance, which is why it is asserted rather than
  -- documented away. (It also carries the pool-side index selectivity.)
  (:AD::uuid, 'D-CROSSPOOL', 'atlas'),
  -- ⚠ a DUPLICATE pool row for D-ASK. The loop is SELECT DISTINCT, and without
  -- it a distribution with a multi-row drop pool (the normal case — one row per
  -- edition) would be swept once per edition and write duplicate history rows.
  (:TS::uuid, 'D-ASK',      'atlas');

INSERT INTO public.pack_distributions (collection_id, dist_id, title, metadata) VALUES
  (:TS::uuid, 'D-ASK',      'Ask Pack',      '{"uuid":"u-ask","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-UNDER',    'Under Pack',    '{"uuid":"u-under","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-NOASK',    'No Ask Pack',   '{"uuid":"u-noask","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-DELISTED', 'Delisted Pack', '{"uuid":"u-del","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-ZEROASK',  'Zero Ask Pack', '{"uuid":"u-zero","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-FAIL',     'Fail Pack',     '{"uuid":"u-fail","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-NULLOK',   'Null Ok Pack',  '{"uuid":"u-nullok","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-BIG',      'Big Pack',      '{"uuid":"u-big","number_of_pack_slots":5}'),
  -- no `title`, and no slot count: the name falls back to metadata.name and the
  -- slots to the floor of 1.
  (:TS::uuid, 'D-NOSLOTS',  NULL,            '{"uuid":"u-noslots","name":"Slotless Pack"}'),
  (:TS::uuid, 'D-NOTATLAS', 'Live Pack',     '{"uuid":"u-live","number_of_pack_slots":5}'),
  (:AD::uuid, 'D-WRONGC',   'AllDay Pack',   '{"uuid":"u-ad","number_of_pack_slots":5}'),
  (:TS::uuid, 'D-CROSSPOOL','Cross Pool',    '{"uuid":"u-cross","number_of_pack_slots":5}');

INSERT INTO public.pack_ask_state (collection_slug, dist_id, is_listed, lowest_ask) VALUES
  ('nba-top-shot', 'D-ASK',      true,  20.00),
  ('nba-top-shot', 'D-UNDER',    true,  90.00),
  ('nba-top-shot', 'D-DELISTED', false, 25.00),   -- delisted: must NOT be used
  ('nba-top-shot', 'D-ZEROASK',  true,  0),       -- zero: must NOT be used
  ('nba-top-shot', 'D-FAIL',     true,  10.00),
  ('nba-top-shot', 'D-NULLOK',   true,  10.00),
  ('nba-top-shot', 'D-BIG',      true,  10.00),
  ('nba-top-shot', 'D-NOSLOTS',  true,  10.00),
  -- ⚠ the ask table is keyed by SLUG, and this row is All Day's. It exists so
  -- dropping the `collection_slug` predicate is observable: D-ASK would then
  -- join two ask rows and be swept twice.
  ('nfl-all-day',  'D-ASK',      true,  1.00);

INSERT INTO public.__ev_fixture (dist_id, payload) VALUES
  ('D-ASK',      '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-UNDER',    '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-NOASK',    '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-DELISTED', '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-ZEROASK',  '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-FAIL',     '{"ok":false,"error":"no priced editions"}'),
  ('D-NULLOK',   '{"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-BIG',      '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":90000}'),
  ('D-NOSLOTS',  '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-NOTATLAS', '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-WRONGC',   '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-CROSSPOOL','{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}');

SELECT _assert_eq(
  (public.refresh_atlas_pack_ev() ->> 'ok'), 'true',
  'the sweep completes'
);

-- ── The +EV claim ───────────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT is_positive_ev::text || '/' || pack_ev::text || '/' || value_ratio::text || '/' || price_source
     FROM public.pack_ev_history WHERE dist_id = 'D-ASK'),
  'true/30.00/2.500/secondary',
  'a listed pack whose EV clears its ask is published +EV, with a real margin and ratio'
);

SELECT _assert_eq(
  (SELECT is_positive_ev::text || '/' || pack_ev::text FROM public.pack_ev_history WHERE dist_id = 'D-UNDER'),
  'false/-40.00',
  'a listed pack whose EV is BELOW its ask is not +EV, and the margin is negative'
);

-- ⚠ PROPERTY 1 + 2 + 3 IN ONE ROW, and the reason they need three columns.
-- With no ask, `pack_ev` is +50.00 — it LOOKS like a $50 profit — while
-- `is_positive_ev` is NOT true and `value_ratio` is NULL. A surface reading the
-- SIGN of pack_ev instead of the flag would publish a buy signal for a pack
-- whose price is unknown.
--
-- ⚠ AND THE FLAG IS **NULL**, NOT FALSE. `lowest_ask > 0` is NULL when the ask
-- is NULL, and `NULL AND NULL` is NULL. That is SAFE for the +EV badge — three-
-- valued logic means `WHERE is_positive_ev`, `NOT is_positive_ev` and a JS
-- truthiness check all treat it as not-positive — but it is a live trap in the
-- other direction: a consumer looking for NEGATIVE-EV packs with
-- `is_positive_ev = false` silently MISSES every ask-less pack. Pinned to the
-- exact value so the distinction is a known property rather than a discovery
-- during an incident.
SELECT _assert_eq(
  (SELECT coalesce(is_positive_ev::text,'NULL') || '/' || pack_ev::text || '/' ||
          coalesce(value_ratio::text,'NULL') || '/' || price_source || '/' ||
          coalesce(secondary_available::text,'NULL')
     FROM public.pack_ev_history WHERE dist_id = 'D-NOASK'),
  'NULL/50.00/NULL/none/NULL',
  'NO ASK: never +EV, ratio withheld rather than fabricated — though pack_ev still reads +50'
);

SELECT _assert_eq(
  (SELECT (is_positive_ev IS NOT TRUE)::text FROM public.pack_ev_history WHERE dist_id = 'D-NOASK'),
  'true',
  '...and IS NOT TRUE is what a consumer must use — the badge is safe, `= false` is not'
);

-- ⚠ A DELISTED pack and a ZERO ask must land in exactly the same state as
-- "no ask". Treating either as a real $0 price would make the pack look
-- infinitely +EV — the single worst false claim this function could make.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history
    WHERE dist_id IN ('D-DELISTED','D-ZEROASK')
      AND is_positive_ev IS NOT TRUE AND value_ratio IS NULL AND price_source = 'none'),
  '2',
  'a DELISTED ask and a ZERO ask are both treated as NO ASK, never as a $0 pack'
);

-- ── The failure branch ──────────────────────────────────────────────────────
-- ⚠ It WRITES rather than skips. Skipping would leave last hour''s row as
-- pack_ev_latest, so a pack that stopped being computable would keep publishing
-- a stale +EV badge indefinitely.
SELECT _assert_eq(
  (SELECT gross_ev::text || '/' || coalesce(typical_ev::text,'NULL') || '/' ||
          is_positive_ev::text || '/' || depletion_pct::text
     FROM public.pack_ev_history WHERE dist_id = 'D-FAIL'),
  '0/NULL/false/100',
  'a FAILED EV computation still writes a row — and it can never be +EV'
);

-- `IS NOT TRUE`, not `= false`: a payload with no `ok` key at all must take the
-- failure branch rather than fall through as a success.
SELECT _assert_eq(
  (SELECT gross_ev::text || '/' || is_positive_ev::text
     FROM public.pack_ev_history WHERE dist_id = 'D-NULLOK'),
  '0/false',
  'a payload with NO ok key takes the failure branch (IS NOT TRUE, not = false)'
);

-- ── Input guards ────────────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT edition_count::text FROM public.pack_ev_history WHERE dist_id = 'D-BIG'),
  '32767',
  'edition_count is clamped to smallint — without it a 22003 aborts the WHOLE hourly sweep'
);

SELECT _assert_eq(
  (SELECT seen_slots::text FROM public.__ev_fixture WHERE dist_id = 'D-NOSLOTS'),
  '1',
  'a distribution with no slot count is floored at 1 slot, never passed NULL'
);

SELECT _assert_eq(
  (SELECT pack_name FROM public.pack_ev_history WHERE dist_id = 'D-NOSLOTS'),
  'Slotless Pack',
  'the pack name falls back to metadata.name when title is NULL'
);

SELECT _assert_eq(
  (SELECT seen_ask::text FROM public.__ev_fixture WHERE dist_id = 'D-NOASK'),
  '0',
  'the EV engine is handed 0, not NULL, when there is no ask'
);

-- ── Scoping ─────────────────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id IN ('D-NOTATLAS','D-WRONGC')),
  '0',
  'a non-atlas pool and another collection are both left alone'
);

-- ⚠ The pool-side collection scope, which the pd join does NOT cover: an atlas
-- pool row under All Day whose dist_id is distributed under Top Shot would
-- otherwise be swept as if it were a Top Shot pack.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-CROSSPOOL'),
  '0',
  'a cross-collection POOL row is not swept — the pd join alone does not stop it'
);

-- ⚠ SELECT DISTINCT: a drop pool holds one row PER EDITION in production, so
-- without it every distribution would be swept once per edition and write that
-- many duplicate history rows — inflating rows_written and giving pack_ev_latest
-- an arbitrary winner among identical rows.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-ASK'),
  '1',
  'a distribution with several drop-pool rows is swept ONCE (SELECT DISTINCT)'
);

-- ── Its own telemetry ───────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT ok::text || '/' || rows_written::text || '/' || collection_slug || '/' || (extra->>'rows')
     FROM public.pipeline_runs WHERE pipeline = 'topshot-atlas-pack-ev'),
  'true/9/nba-top-shot/9',
  'the success path logs its own pipeline_runs row — the ONLY path that logs at all'
);

ROLLBACK;
