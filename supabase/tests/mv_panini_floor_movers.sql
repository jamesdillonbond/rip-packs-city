-- DB invariant: public.mv_panini_floor_movers — Panini "Floor movers · 7 days"
-- (migration 20261104182819_audit_20261104_panini_floor_movers.sql). Claims:
--   1. a real rise and a real fall between day_then (newest lane day − 7) and day_now are both kept, with the right
--      ask then / now, change and direction;
--   2. an edition that LEFT the board (NULL ask now) is never a move;
--   3. an ask under $5 on either day is left out;
--   4. an unchanged floor (even one that moved and came back inside the window) is left out;
--   5. a RISE where a copy at or under the old floor is still marked listed but was not re-read in 7 days is left out
--      (an age-out, not a move) — and the same rise with that copy NOT listed is kept;
--   6. an edition with no state on day_then is left out (no base);
--   7. window_complete is true with a lane row on all 7 window days and false after one day goes missing.
--
-- The MV DDL below is VERBATIM from the committed migration;
-- __tests__/panini-floor-movers-pin-matches-migration.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.panini_edition_ask_daily (external_id text NOT NULL, day date NOT NULL, low_ask_usd numeric, listed_count integer, PRIMARY KEY (external_id, day));
CREATE TABLE public.panini_editions (external_id text, player_name text, set_name text, parallel text, mint_cap integer, product_set_id integer);
CREATE TABLE public.panini_products (set_id integer, name text, last_grid_sport text);
CREATE TABLE public.panini_card_serials (edition_external_id text, is_listed boolean, price_usd numeric, captured_at timestamptz);

INSERT INTO public.panini_products VALUES (1, 'Prizm WC', 'soccer');
INSERT INTO public.panini_editions
  SELECT x, 'Player ' || x, 'Set', 'Base', 99, 1 FROM unnest(ARRAY['R','F','L','U','C','D','A','A2','N','Z']) AS x;

-- day_now = 2026-11-04, day_then = 2026-10-28
INSERT INTO public.panini_edition_ask_daily (external_id, day, low_ask_usd) VALUES
  ('R',  '2026-10-25', 10), ('R',  '2026-11-02', 15),
  ('F',  '2026-10-28', 20), ('F',  '2026-11-01', 16),
  ('L',  '2026-10-20', 10), ('L',  '2026-11-03', NULL),
  ('U',  '2026-10-26', 10), ('U',  '2026-10-30', 12), ('U', '2026-11-03', 10),
  ('C',  '2026-10-26', 4),  ('C',  '2026-11-01', 8),
  ('D',  '2026-10-26', 10), ('D',  '2026-11-01', 3),
  ('A',  '2026-10-26', 10), ('A',  '2026-11-01', 30),
  ('A2', '2026-10-26', 10), ('A2', '2026-11-01', 30),
  ('N',  '2026-11-01', 50);
-- a lane row on every day of the window (Z sits under $5, so it is never a mover itself)
INSERT INTO public.panini_edition_ask_daily (external_id, day, low_ask_usd)
  SELECT 'Z', d::date, 1 + extract(day FROM d)::int / 100.0 FROM generate_series('2026-10-29'::date, '2026-11-04'::date, interval '1 day') d;

-- A: the $10 copy is still marked listed but was last re-read 10 days ago (aged out of the board) → not a move
-- A2: the same $10 copy, re-read and no longer listed → a real rise
INSERT INTO public.panini_card_serials VALUES
  ('A',  true,  10, now() - interval '10 days'),
  ('A',  true,  30, now() - interval '1 day'),
  ('A2', false, 10, now() - interval '2 days'),
  ('A2', true,  30, now() - interval '1 day');

-- >>> BEGIN verbatim mv_panini_floor_movers >>>
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_floor_movers AS
WITH b AS MATERIALIZED (
  SELECT max(h.day) AS day_now FROM public.panini_edition_ask_daily h
), w AS MATERIALIZED (
  SELECT b.day_now, b.day_now - 7 AS day_then,
         (SELECT count(DISTINCT h.day) FROM public.panini_edition_ask_daily h
           WHERE h.day > b.day_now - 7 AND h.day <= b.day_now)::int AS lane_days
    FROM b
), s_then AS MATERIALIZED (
  SELECT DISTINCT ON (h.external_id) h.external_id, h.low_ask_usd
    FROM public.panini_edition_ask_daily h, w WHERE h.day <= w.day_then
   ORDER BY h.external_id, h.day DESC
), s_now AS MATERIALIZED (
  SELECT DISTINCT ON (h.external_id) h.external_id, h.low_ask_usd, h.listed_count
    FROM public.panini_edition_ask_daily h, w WHERE h.day <= w.day_now
   ORDER BY h.external_id, h.day DESC
), mv AS (
  SELECT n.external_id, t.low_ask_usd AS ask_then_usd, n.low_ask_usd AS ask_now_usd, n.listed_count AS listed_now
    FROM s_now n JOIN s_then t ON t.external_id = n.external_id
   WHERE t.low_ask_usd >= 5 AND n.low_ask_usd >= 5 AND n.low_ask_usd <> t.low_ask_usd
)
SELECT mv.external_id,
       pe.player_name, pe.set_name, pe.parallel, pe.mint_cap,
       pp.name AS product_name, pp.last_grid_sport AS sport,
       mv.ask_then_usd, mv.ask_now_usd, mv.listed_now,
       round(mv.ask_now_usd - mv.ask_then_usd, 2) AS change_usd,
       round((mv.ask_now_usd / mv.ask_then_usd - 1) * 100, 1) AS change_pct,
       CASE WHEN mv.ask_now_usd > mv.ask_then_usd THEN 'rise' ELSE 'fall' END AS direction,
       w.day_then, w.day_now, (w.lane_days = 7) AS window_complete,
       now() AS computed_at
  FROM mv
  CROSS JOIN w
  JOIN public.panini_editions pe ON pe.external_id = mv.external_id
  LEFT JOIN public.panini_products pp ON pp.set_id = pe.product_set_id
 WHERE NOT (mv.ask_now_usd > mv.ask_then_usd AND EXISTS (
         SELECT 1 FROM public.panini_card_serials cs
          WHERE cs.edition_external_id = mv.external_id AND cs.is_listed
            AND cs.price_usd > 0 AND cs.price_usd <= mv.ask_then_usd
            AND cs.captured_at <= now() - interval '7 days'))
WITH NO DATA;
-- <<< END verbatim mv_panini_floor_movers <<<

REFRESH MATERIALIZED VIEW public.mv_panini_floor_movers;

SELECT _assert_eq((SELECT string_agg(external_id, ',' ORDER BY external_id) FROM public.mv_panini_floor_movers), 'A2,F,R',
  'only the real rises and falls are kept (L left the board, C and D under $5, U unchanged, A aged out, N no base)');
SELECT _assert_eq((SELECT format('%s|%s|%s|%s|%s', ask_then_usd, ask_now_usd, change_usd, change_pct, direction) FROM public.mv_panini_floor_movers WHERE external_id = 'R'),
  '10|15|5.00|50.0|rise', 'a rise carries ask then / now, change and direction');
SELECT _assert_eq((SELECT format('%s|%s|%s|%s', ask_then_usd, ask_now_usd, change_pct, direction) FROM public.mv_panini_floor_movers WHERE external_id = 'F'),
  '20|16|-20.0|fall', 'a fall carries a negative change');
SELECT _assert_eq((SELECT format('%s|%s', min(day_then), max(day_now)) FROM public.mv_panini_floor_movers), '2026-10-28|2026-11-04',
  'the window is the newest lane day and 7 days before it');
SELECT _assert((SELECT bool_and(window_complete) FROM public.mv_panini_floor_movers), 'window_complete with a lane row on all 7 days');
SELECT _assert_eq((SELECT format('%s|%s', product_name, sport) FROM public.mv_panini_floor_movers WHERE external_id = 'R'), 'Prizm WC|soccer', 'product + sport joined');

-- one lane day missing → the window is NOT complete
DELETE FROM public.panini_edition_ask_daily WHERE day = '2026-10-31';
REFRESH MATERIALIZED VIEW public.mv_panini_floor_movers;
SELECT _assert((SELECT NOT bool_or(window_complete) FROM public.mv_panini_floor_movers), 'a missing lane day clears window_complete');

\echo '✓ mv_panini_floor_movers: rises/falls kept; left-board, <$5, unchanged, aged-out, no-base excluded; window flag'
ROLLBACK;
