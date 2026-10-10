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
-- ⚠ FIXED 2026-10-10 — A FAILED SWEEP USED TO BE INVISIBLE. The handler returned
-- `{ok:false}` without logging, so a failure left NO pipeline_runs row. It now logs
-- ok=false with the error (pinned below). The same day, the pool widening of
-- known-issues #65 (57 -> ~820 Atlas dists) made three latent aborts reachable, each
-- of which took the WHOLE sweep down: a NULL flag on an ask-less dist (the live column
-- is NOT NULL), a NULL listing uuid (pack_listing_id is NOT NULL), and a $1,000,000
-- troll ask driving pack_ev past the CHECK range. All three are pinned below, and the
-- fixture now mirrors prod's NOT NULL / CHECK so it cannot accept them again.

-- ⚠ `compute_pack_ev_per_edition_weighted` below is a TEST STAND-IN, not the
-- real function — that one has its own pin. It returns whatever the fixture
-- table tells it to, so the failure branch and the smallint clamp are reachable,
-- and it RECORDS the slots/ask it was handed so the input guards are assertable.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010164507_audit_20261010_refresh_atlas_pack_ev_survives_a_wider_pool.sql;
-- built from this pin after proving pin == live, normalised-prosrc md5 90590db2123d2aa9f51105c38f9e0be1).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- ⚠ The md5 above is over `pg_proc.prosrc` (the BODY). The previous header
-- recorded acbe79769403d75542bf17f1550959a9 against `pg_get_functiondef`
-- output (body PLUS the CREATE header and SET clauses) on 2026-08-16 — two
-- different expressions over two different strings, so the two values were
-- never comparable and neither is wrong. Recorded because a digest without the
-- expression that produced it cannot be verified later: state which one, or the
-- next reader re-derives a mismatch and reports drift that is not there.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_drop_pool (
  collection_id uuid,
  dist_id       text,
  pool_source   text
);

-- ⚠ `total_sealed` / `depletion_pct` were added to this fixture 2026-09-07 with
-- the supply fix (migration 20260908003056). They are the REAL supply the
-- success branch now publishes in place of a fabricated `0`. Types mirror prod
-- exactly — `total_sealed` integer, `depletion_pct` smallint — because the
-- history columns they feed are integer / smallint and a widened fixture would
-- hide an overflow the real table would raise.
CREATE TABLE public.pack_distributions (
  collection_id uuid,
  dist_id       text,
  title         text,
  metadata      jsonb,
  total_sealed  int,
  depletion_pct smallint
);

CREATE TABLE public.pack_ask_state (
  collection_slug text,
  dist_id         text,
  is_listed       boolean,
  lowest_ask      numeric
);

-- ⚠ NOT NULL / CHECK mirror prod (added 2026-10-10): without them this fixture accepted the
-- NULL flag, the NULL listing id and the out-of-range margin that each aborted the live sweep.
CREATE TABLE public.pack_ev_history (
  pack_listing_id      text NOT NULL,
  collection_id        uuid,
  dist_id              text,
  pack_name            text,
  pack_price           numeric,
  primary_price        numeric,
  secondary_ask        numeric,
  price_source         text,
  primary_available    boolean,
  secondary_available  boolean,
  gross_ev             numeric NOT NULL,
  typical_ev           numeric,
  pack_ev              numeric NOT NULL CHECK (pack_ev >= -10000 AND pack_ev <= 1000000),
  is_positive_ev       boolean NOT NULL DEFAULT false,
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
  v_unkeyed int := 0;
  v_now timestamptz := now();
BEGIN
  -- a dist with no listing uuid cannot be written (pack_listing_id is NOT NULL, and
  -- pack_ev_latest is keyed on it): counted, not swept, so it cannot abort the sweep
  SELECT count(DISTINCT p.dist_id) INTO v_unkeyed
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
   WHERE p.collection_id = v_cid AND p.pool_source = 'atlas' AND pd.metadata->>'uuid' IS NULL;

  FOR r IN
    SELECT DISTINCT p.dist_id,
           pd.metadata->>'uuid' AS listing_uuid,
           COALESCE(pd.title, pd.metadata->>'name') AS title,
           GREATEST(COALESCE((pd.metadata->>'number_of_pack_slots')::int, 1), 1) AS slots,
           pas.lowest_ask,
           pd.total_sealed,
           pd.depletion_pct
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = p.dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE p.collection_id = v_cid AND p.pool_source = 'atlas'
      AND pd.metadata->>'uuid' IS NOT NULL
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
      -- clamped to the column's sane range (as compute_pack_ev_per_edition_weighted clamps
      -- its own): a troll ask ($1,000,000 on two live dists) is otherwise a CHECK violation
      -- that aborts the whole sweep. The flag is computed from the unclamped margin.
      GREATEST(LEAST(round(v_gross - COALESCE(r.lowest_ask, 0), 2), 1000000), -10000),
      -- no ask -> FALSE, never NULL: the live column is NOT NULL (a NULL aborted the sweep)
      COALESCE(r.lowest_ask > 0 AND (v_gross - r.lowest_ask) > 0, false),
      CASE WHEN r.lowest_ask > 0 THEN round(v_gross / r.lowest_ask, 3) ELSE NULL END,
      (ev->>'fmv_coverage_pct')::smallint, LEAST((ev->>'edition_count')::int, 32767), r.total_sealed, r.depletion_pct, v_now);
    v_written := v_written + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written + v_unkeyed, v_written, v_unkeyed, true, NULL,
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', v_written, 'unkeyed', v_unkeyed));
  RETURN jsonb_build_object('ok', true, 'written', v_written, 'unkeyed', v_unkeyed, 'finished_at', now());
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- a failed sweep LOGS (it used to return silently, leaving no pipeline_runs row); the
  -- rows it wrote roll back with it, so rows_written is 0
  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, 0, 0, false, left(SQLERRM, 300),
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', 0, 'reached', v_written));
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'written', 0);
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
-- D-SOLDOUT  : EV clears the ask, but total_sealed = 0     -> writes a REAL 0/100
-- D-NOSUPPLY : EV clears the ask, supply UNKNOWN (NULL)    -> writes NULL, never 0
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
  -- ⚠ The two supply controls, added 2026-09-07 with the fix that made the
  -- success branch publish REAL supply instead of a fabricated 0. They run in
  -- OPPOSITE directions on purpose: without D-SOLDOUT the pin would only prove
  -- "not zero" (satisfiable by any wrong non-zero constant), and without
  -- D-NOSUPPLY it would not notice a COALESCE(total_sealed, 0) putting the
  -- defect straight back.
  (:TS::uuid, 'D-SOLDOUT',  'atlas'),
  (:TS::uuid, 'D-NOSUPPLY', 'atlas'),
  -- 2026-10-10: a troll ask, and a dist with no listing uuid -- each aborted the live sweep
  (:TS::uuid, 'D-TROLL',    'atlas'),
  (:TS::uuid, 'D-NOUUID',   'atlas'),
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

-- ⚠ COLUMN-LEVEL FIXTURE AUDIT, 2026-09-07. `total_sealed` / `depletion_pct`
-- carry REAL values on every row rather than defaulting to NULL. The repo rule
-- for repointing a DB pin is that a new read must resolve to something, or the
-- assertion passes while proving nothing — a fixture-wide NULL would have made
-- the "publishes real supply" assertions below vacuous in exactly the direction
-- the defect ran.
--
-- ⚠ D-FAIL and D-NULLOK deliberately carry REAL supply (900 / 10) even though
-- they take the failure branch. That is the control proving the failure branch
-- is UNTOUCHED by this change: it must still write its documented 0 / 100
-- sentinel while real supply sits right there in the row, so a future edit
-- cannot quietly make property 4 depend on the data.
INSERT INTO public.pack_distributions (collection_id, dist_id, title, metadata, total_sealed, depletion_pct) VALUES
  (:TS::uuid, 'D-ASK',      'Ask Pack',      '{"uuid":"u-ask","number_of_pack_slots":5}',    1200,  40),
  (:TS::uuid, 'D-UNDER',    'Under Pack',    '{"uuid":"u-under","number_of_pack_slots":5}',   500,  55),
  (:TS::uuid, 'D-NOASK',    'No Ask Pack',   '{"uuid":"u-noask","number_of_pack_slots":5}',   500,  55),
  (:TS::uuid, 'D-DELISTED', 'Delisted Pack', '{"uuid":"u-del","number_of_pack_slots":5}',     500,  55),
  (:TS::uuid, 'D-ZEROASK',  'Zero Ask Pack', '{"uuid":"u-zero","number_of_pack_slots":5}',    500,  55),
  (:TS::uuid, 'D-FAIL',     'Fail Pack',     '{"uuid":"u-fail","number_of_pack_slots":5}',    900,  10),
  (:TS::uuid, 'D-NULLOK',   'Null Ok Pack',  '{"uuid":"u-nullok","number_of_pack_slots":5}',  900,  10),
  (:TS::uuid, 'D-BIG',      'Big Pack',      '{"uuid":"u-big","number_of_pack_slots":5}',     700,  25),
  -- no `title`, and no slot count: the name falls back to metadata.name and the
  -- slots to the floor of 1.
  (:TS::uuid, 'D-NOSLOTS',  NULL,            '{"uuid":"u-noslots","name":"Slotless Pack"}',   700,  25),
  -- a pack that really IS sold out: the 0 it publishes is MEASURED, not fabricated.
  (:TS::uuid, 'D-SOLDOUT',  'Sold Out Pack', '{"uuid":"u-soldout","number_of_pack_slots":5}',   0, 100),
  -- supply genuinely UNKNOWN. Must stay NULL all the way to pack_ev_history.
  (:TS::uuid, 'D-NOSUPPLY', 'No Supply Pack','{"uuid":"u-nosupply","number_of_pack_slots":5}',NULL,NULL),
  (:TS::uuid, 'D-TROLL',    'Troll Pack',    '{"uuid":"u-troll","number_of_pack_slots":5}',   500,  55),
  (:TS::uuid, 'D-NOUUID',   'Keyless Pack',  '{"number_of_pack_slots":5}',                     500,  55),
  (:TS::uuid, 'D-NOTATLAS', 'Live Pack',     '{"uuid":"u-live","number_of_pack_slots":5}',    500,  55),
  (:AD::uuid, 'D-WRONGC',   'AllDay Pack',   '{"uuid":"u-ad","number_of_pack_slots":5}',      500,  55),
  (:TS::uuid, 'D-CROSSPOOL','Cross Pool',    '{"uuid":"u-cross","number_of_pack_slots":5}',   500,  55);

INSERT INTO public.pack_ask_state (collection_slug, dist_id, is_listed, lowest_ask) VALUES
  ('nba-top-shot', 'D-ASK',      true,  20.00),
  ('nba-top-shot', 'D-UNDER',    true,  90.00),
  ('nba-top-shot', 'D-DELISTED', false, 25.00),   -- delisted: must NOT be used
  ('nba-top-shot', 'D-ZEROASK',  true,  0),       -- zero: must NOT be used
  ('nba-top-shot', 'D-FAIL',     true,  10.00),
  ('nba-top-shot', 'D-NULLOK',   true,  10.00),
  ('nba-top-shot', 'D-BIG',      true,  10.00),
  ('nba-top-shot', 'D-NOSLOTS',  true,  10.00),
  -- both supply controls are listed with an ask their EV clears, so each would
  -- be +EV on every OTHER property — supply is the only thing separating them.
  ('nba-top-shot', 'D-SOLDOUT',  true,  20.00),
  ('nba-top-shot', 'D-NOSUPPLY', true,  20.00),
  ('nba-top-shot', 'D-TROLL',    true,  1000000),
  ('nba-top-shot', 'D-NOUUID',   true,  20.00),
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
  ('D-SOLDOUT',  '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-NOSUPPLY', '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-TROLL',    '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
  ('D-NOUUID',   '{"ok":true,"gross_ev":50.00,"typical_pull_ev":12.00,"fmv_coverage_pct":88,"edition_count":40}'),
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
-- ⚠ THE FLAG IS **FALSE**, NOT NULL (inverted 2026-10-10). It used to be NULL
-- (`lowest_ask > 0` is NULL when the ask is NULL) — and the live column is
-- NOT NULL, so the first ask-less Atlas dist aborted the WHOLE hourly sweep; this
-- fixture had no NOT NULL and pinned the NULL as a property. COALESCE(..., false)
-- now: "no known price" is not +EV, and `= false` finds ask-less packs too.
SELECT _assert_eq(
  (SELECT coalesce(is_positive_ev::text,'NULL') || '/' || pack_ev::text || '/' ||
          coalesce(value_ratio::text,'NULL') || '/' || price_source || '/' ||
          coalesce(secondary_available::text,'NULL')
     FROM public.pack_ev_history WHERE dist_id = 'D-NOASK'),
  'false/50.00/NULL/none/NULL',
  'NO ASK: never +EV (false, not NULL), ratio withheld rather than fabricated — though pack_ev still reads +50'
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

-- ── Supply: the two columns that decide whether a row can EVER be published ──
--
-- ⭐ ADDED 2026-09-07 WITH THE FIX, AND THE REASON THEY EXIST IS THAT THEY DID
-- NOT. `total_unopened` was asserted NOWHERE in this pin, and `depletion_pct`
-- only on the failure branch — so for three weeks the success branch hardcoded
-- `0, NULL`, `pack_ev_latest` read that fabricated 0 as SOLD OUT, and every row
-- this function wrote was barred from the +EV board with the whole pin green.
-- 573 live rows, 0 of them ever publishable. A guard is silent about what it
-- does not name.
--
-- `pack_ev_latest` (not in this fixture — it is a view over the real table)
-- applies: total_unopened IS NOT NULL AND total_unopened <= 0 -> false, and
-- depletion_pct IS NOT NULL AND depletion_pct >= 100 -> false. So these two
-- columns can VETO the flag the function just computed, which is why they are
-- pinned at the same level as the flag itself.
SELECT _assert_eq(
  (SELECT total_unopened::text || '/' || depletion_pct::text
     FROM public.pack_ev_history WHERE dist_id = 'D-ASK'),
  '1200/40',
  'the success branch publishes the REAL supply from pack_distributions, not a fabricated 0'
);

-- ⚠ THE OTHER DIRECTION, and without it the assertion above is satisfiable by
-- any wrong constant: a pack that genuinely IS sold out must still write 0/100.
-- The fix is "publish what pd says", not "publish something non-zero".
SELECT _assert_eq(
  (SELECT total_unopened::text || '/' || depletion_pct::text
     FROM public.pack_ev_history WHERE dist_id = 'D-SOLDOUT'),
  '0/100',
  'a genuinely sold-out pack publishes a MEASURED 0 — the veto is correct when the data says so'
);

-- ⚠ THE ANTI-REGRESSION. Unknown supply must stay NULL all the way through.
-- `pack_ev_latest` reads NULL as "unknown" and lets the computed flag stand —
-- which is exactly why the 100 rows other writers leave NULL can be +EV while
-- none of this writer's 573 zeros could. A COALESCE(pd.total_sealed, 0) would
-- restore the original defect while both assertions above still passed.
SELECT _assert_eq(
  (SELECT coalesce(total_unopened::text,'NULL') || '/' || coalesce(depletion_pct::text,'NULL')
     FROM public.pack_ev_history WHERE dist_id = 'D-NOSUPPLY'),
  'NULL/NULL',
  'UNKNOWN supply is withheld as NULL, never published as a measured 0'
);

-- ⚠ The defect''s exact signature, asserted at population zero so it cannot
-- come back in a row this pin does not name individually: a SUCCESS-branch row
-- (gross_ev > 0 is only reachable there) carrying `total_unopened = 0` with
-- `depletion_pct IS NULL` is the fabricated pair and nothing else produces it.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history
    WHERE gross_ev > 0 AND total_unopened = 0 AND depletion_pct IS NULL),
  '0',
  'no success-branch row carries the fabricated (0, NULL) supply pair'
);

-- ── The failure branch ──────────────────────────────────────────────────────
-- ⚠ It WRITES rather than skips. Skipping would leave last hour''s row as
-- pack_ev_latest, so a pack that stopped being computable would keep publishing
-- a stale +EV badge indefinitely.
--
-- ⚠ `total_unopened` is asserted here too, and D-FAIL''s fixture carries REAL
-- supply (900 sealed, 10% depleted). The sentinel must IGNORE it: property 4 is
-- that an uncomputable pack cannot publish a +EV badge, and that must not become
-- conditional on the supply data now that the success branch reads it.
SELECT _assert_eq(
  (SELECT gross_ev::text || '/' || coalesce(typical_ev::text,'NULL') || '/' ||
          is_positive_ev::text || '/' || total_unopened::text || '/' || depletion_pct::text
     FROM public.pack_ev_history WHERE dist_id = 'D-FAIL'),
  '0/NULL/false/0/100',
  'a FAILED EV computation still writes a row — sentinel supply, never the real supply, and never +EV'
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

-- ── The three shapes that each aborted the live sweep (2026-10-10) ───────────
SELECT _assert_eq(
  (SELECT pack_ev::text || '/' || is_positive_ev::text FROM public.pack_ev_history WHERE dist_id = 'D-TROLL'),
  '-10000/false',
  'a troll ask is clamped to the sane range (never a CHECK abort), and is never +EV'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-NOUUID'),
  '0',
  'a dist with no listing uuid is not swept (pack_listing_id is NOT NULL)'
);

-- ── Its own telemetry ───────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT ok::text || '/' || rows_written::text || '/' || collection_slug || '/' || (extra->>'rows') || '/' || (extra->>'unkeyed')
     FROM public.pipeline_runs WHERE pipeline = 'topshot-atlas-pack-ev'),
  'true/12/nba-top-shot/12/1',
  'the success path logs its own pipeline_runs row, with the unkeyed dists counted'
);

-- ⚠ A FAILED SWEEP LOGS (2026-10-10; it used to return {ok:false} and log nothing)
ALTER TABLE public.pack_ev_history RENAME TO pack_ev_history_x;
SELECT _assert_eq((public.refresh_atlas_pack_ev() ->> 'ok'), 'false', 'a failing sweep reports ok:false');
SELECT _assert_eq(
  (SELECT ok::text || '/' || rows_written::text || '/' || (error IS NOT NULL)::text
     FROM public.pipeline_runs WHERE pipeline = 'topshot-atlas-pack-ev' ORDER BY ctid DESC LIMIT 1),
  'false/0/true',
  'a failing sweep writes an ok=false pipeline_runs row with its error and 0 rows written'
);

ROLLBACK;
