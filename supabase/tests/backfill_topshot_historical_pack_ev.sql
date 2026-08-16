-- DB invariant: public.backfill_topshot_historical_pack_ev — pg_cron
-- `rpc-backfill-historical-pack-ev` @ `13 * * * *`.
--
-- WHAT IT DOES. Backfills pack EV for Top Shot distributions priced at their
-- PRIMARY retail price — unlike refresh_atlas_pack_ev, which prices against the
-- secondary ask. It writes to `pack_ev_history`, the table behind
-- `pack_ev_latest` and the PUBLIC **+EV** badge.
--
-- ⚠ OPERATIONAL NOTE: this is one of the three heavy pg_cron jobs CLAUDE.md
-- names as colliding at `:13`, the collision behind the platform-wide disk-IO
-- saturation. Any change to its cadence or `p_limit` is an IO-budget change.
--
-- ── THE GUARDS ─────────────────────────────────────────────────────────────
--
--   1. ⚠ `gross_ev <= 3 * sec_ask` — THE SURVIVOR-BIAS CAP, and the reason this
--      function is worth pinning at all. CLAUDE.md records that a DEPLETED Top
--      Shot pool prices at 40-86x: once the good moments are pulled, what
--      remains is the tail, and an EV computed over the original pool produces
--      an absurd multiple. This clause DISCARDS such a row rather than
--      publishing it. Removing it does not add noise — it puts a green +EV
--      badge on packs that are nothing of the sort, on an unfurl seen by people
--      who never open the page.
--   2. ⚠ `c.sec_ask IS NOT NULL` — nothing is written without a live secondary
--      ask. That is what gives guard 1 a denominator: with no ask there is no
--      sanity anchor, so the row is SKIPPED rather than published unchecked.
--      ⚠ It is REDUNDANT behind guard 1 today — `gross_ev <= 3 * NULL` is NULL,
--      which already excludes the row — and a mutation dropping it alone passes.
--      Dropping BOTH reds, so the assertion is on the composite. Worth keeping
--      and worth stating: it makes the intent explicit, and it becomes
--      load-bearing the moment guard 1 is ever relaxed or reordered.
--   3. ⚠ The satoshi conversion: a `retail_price_usd` at or above 1000000 is
--      divided by 1e8. Some metadata carries the price in satoshi-like units,
--      and getting this wrong in either direction moves the pack price by eight
--      orders of magnitude, along with every EV derived from it.
--   4. `count(DISTINCT drop_weight) > 1` — only genuinely WEIGHTED pools are
--      backfilled. A pool whose weights are all identical carries no weighting
--      information, so a weighted EV over it is a uniform average wearing a
--      weighted label.
--   5. ⚠ The 12-hour NOT EXISTS carries `COALESCE(h.edition_count, 0) > 0`, so a
--      SENTINEL row (a failed computation, edition_count 0) does NOT count as
--      covered and the distribution is retried. Without that clause one failure
--      suppresses retries for 12 hours.
--   6. `(c.ev->>'ok')::boolean = true` — a failed EV computation writes NOTHING.
--      ⚠ The OPPOSITE of refresh_atlas_pack_ev, which writes a sentinel on
--      failure. Both are right for their own job: the hourly sweep must
--      invalidate its own previous row, while this is a backfill whose absence
--      just means "not yet done" — and guard 5 is what makes that safe.
--   7. `COALESCE((ev->>'is_positive_ev')::boolean, false)` — never NULL, again
--      unlike its atlas sibling, whose success path can yield NULL.
--   8. `LIMIT GREATEST(p_limit, 1)` — a zero or negative limit would make the
--      job a silent permanent no-op.
--   9. Scoped to Top Shot, and requires a metadata uuid and a positive retail
--      price. ⚠ The collection scope is likewise redundant behind the ask
--      lookup, which is pinned to `collection_slug = 'nba-top-shot'`: a non-Top-
--      Shot distribution gets `sec_ask` NULL and is dropped by guards 1/2. It
--      only becomes load-bearing if a dist_id is shared across collections AND
--      the Top Shot one has a live ask — measured live 2026-08-16, **0 dist_ids
--      in `pack_distributions` span collections**, so that state does not exist
--      today. NOT asserted (a fixture would assert a state prod has never
--      produced); recorded here with what would make it matter. It also carries
--      the scan's selectivity across 5,509 distributions, which is reason enough
--      to keep it.
--
-- ⚠ RECORDED, NOT CHANGED: no exception handler and no `pipeline_runs` row at
-- all, so a failure is invisible except as a stalled backlog, and pg_cron
-- discards the returned insert count.
--
-- ⚠ `compute_pack_ev_per_edition_weighted` below is a TEST STAND-IN, not the
-- real engine — that one has its own pin. It returns what the fixture table
-- dictates and RECORDS the price/slots it was handed, which is how the satoshi
-- conversion and the slots fallback are asserted.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816060000_audit_20260816_snapshot_backfill_topshot_historical_pack_ev.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 e3e87cba0b3fa7199ac4fc307892142c).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_distributions (
  collection_id uuid,
  dist_id       text,
  title         text,
  metadata      jsonb
);

CREATE TABLE public.pack_drop_pool (
  collection_id uuid,
  dist_id       text,
  drop_weight   numeric
);

CREATE TABLE public.pack_ask_state (
  collection_slug text,
  dist_id         text,
  is_listed       boolean,
  lowest_ask      numeric
);

CREATE TABLE public.pack_ev_history (
  pack_listing_id  text,
  collection_id    uuid,
  dist_id          text,
  pack_name        text,
  pack_price       numeric,
  gross_ev         numeric,
  pack_ev          numeric,
  is_positive_ev   boolean,
  value_ratio      numeric,
  fmv_coverage_pct smallint,
  edition_count    smallint,
  typical_ev       numeric,
  snapshotted_at   timestamptz
);

CREATE TABLE public.__ev_fixture (
  dist_id    text PRIMARY KEY,
  payload    jsonb,
  seen_price numeric,
  seen_slots int
);

CREATE FUNCTION public.compute_pack_ev_per_edition_weighted(
  p_cid uuid, p_dist text, p_price numeric, p_slots int
) RETURNS jsonb LANGUAGE plpgsql AS $ev$
BEGIN
  UPDATE public.__ev_fixture SET seen_price = p_price, seen_slots = p_slots WHERE dist_id = p_dist;
  RETURN (SELECT payload FROM public.__ev_fixture WHERE dist_id = p_dist);
END $ev$;

-- >>> BEGIN verbatim backfill_topshot_historical_pack_ev (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.backfill_topshot_historical_pack_ev(p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted int;
BEGIN
  WITH cand AS (
    SELECT d.dist_id, d.collection_id, d.title, d.metadata,
           CASE WHEN (d.metadata->>'retail_price_usd')::numeric >= 1000000
                THEN round((d.metadata->>'retail_price_usd')::numeric/100000000,2)
                ELSE round((d.metadata->>'retail_price_usd')::numeric,2) END AS pack_price,
           COALESCE(NULLIF((d.metadata->>'number_of_pack_slots'),'')::int, 1) AS slots,
           (SELECT a.lowest_ask FROM pack_ask_state a
             WHERE a.dist_id = d.dist_id AND a.collection_slug = 'nba-top-shot'
               AND a.is_listed IS TRUE AND a.lowest_ask > 0
             ORDER BY a.lowest_ask ASC LIMIT 1) AS sec_ask
    FROM pack_distributions d
    WHERE d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND d.metadata->>'uuid' IS NOT NULL
      AND (d.metadata->>'retail_price_usd') IS NOT NULL
      AND (d.metadata->>'retail_price_usd')::numeric > 0
      AND (SELECT count(DISTINCT p.drop_weight) FROM pack_drop_pool p
           WHERE p.collection_id = d.collection_id AND p.dist_id = d.dist_id
             AND p.drop_weight > 0) > 1
      AND NOT EXISTS (SELECT 1 FROM pack_ev_history h
                  WHERE h.collection_id = d.collection_id AND h.dist_id = d.dist_id
                    AND h.snapshotted_at > now() - interval '12 hours'
                    AND COALESCE(h.edition_count, 0) > 0)
    LIMIT GREATEST(p_limit, 1)
  ),
  computed AS (
    SELECT c.*, public.compute_pack_ev_per_edition_weighted(c.collection_id, c.dist_id, c.pack_price, c.slots) AS ev
    FROM cand c
  ),
  ins AS (
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
                                 gross_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct,
                                 edition_count, typical_ev, snapshotted_at)
    SELECT c.metadata->>'uuid', c.collection_id, c.dist_id, c.title, c.pack_price,
           (c.ev->>'gross_ev')::numeric, (c.ev->>'pack_ev')::numeric,
           COALESCE((c.ev->>'is_positive_ev')::boolean, false),
           (c.ev->>'value_ratio')::numeric, (c.ev->>'fmv_coverage_pct')::smallint,
           (c.ev->>'edition_count')::smallint,
           (c.ev->>'typical_pull_ev')::numeric,
           now()
    FROM computed c
    WHERE (c.ev->>'ok')::boolean = true
      AND c.sec_ask IS NOT NULL
      AND (c.ev->>'gross_ev')::numeric <= 3 * c.sec_ask
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END
$function$;
-- <<< END verbatim backfill_topshot_historical_pack_ev <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''

-- D-OK        : weighted pool, live ask, EV within 3x       -> INSERTED
-- D-ABSURD    : same but gross_ev = 40x the ask             -> DISCARDED (guard 1)
-- D-EDGE      : gross_ev EXACTLY 3x the ask                 -> INSERTED (<=, not <)
-- D-NOASK     : no live ask                                 -> DISCARDED (guard 2)
-- D-DELISTED  : ask exists but is_listed = false            -> counts as NO ask
-- D-SATOSHI   : retail_price_usd 1000000000 (10.00 in sats) -> converted
-- D-UNIFORM   : every drop_weight identical                 -> not a candidate
-- D-COVERED   : already has a fresh row WITH editions       -> skipped
-- D-SENTINEL  : has a fresh row with edition_count 0        -> RETRIED
-- D-EVFAIL    : EV engine returns ok:false                  -> writes nothing
-- D-NOSLOTS   : metadata has an EMPTY slots string          -> NULLIF -> 1
-- D-ZEROPRICE : retail_price_usd 0                          -> not a candidate
-- D-WRONGC    : All Day                                     -> not a candidate
INSERT INTO public.pack_distributions (collection_id, dist_id, title, metadata) VALUES
  (:TS::uuid, 'D-OK',       'Ok Pack',       '{"uuid":"u-ok","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-ABSURD',   'Absurd Pack',   '{"uuid":"u-abs","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-EDGE',     'Edge Pack',     '{"uuid":"u-edge","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-NOASK',    'No Ask Pack',   '{"uuid":"u-noask","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-DELISTED', 'Delisted Pack', '{"uuid":"u-del","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-SATOSHI',  'Satoshi Pack',  '{"uuid":"u-sat","retail_price_usd":1000000000,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-UNIFORM',  'Uniform Pack',  '{"uuid":"u-uni","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-COVERED',  'Covered Pack',  '{"uuid":"u-cov","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-SENTINEL', 'Sentinel Pack', '{"uuid":"u-sen","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-EVFAIL',   'EvFail Pack',   '{"uuid":"u-fail","retail_price_usd":9,"number_of_pack_slots":5}'),
  (:TS::uuid, 'D-NOSLOTS',  'Slotless Pack', '{"uuid":"u-nos","retail_price_usd":9,"number_of_pack_slots":""}'),
  (:TS::uuid, 'D-ZEROPRICE','Free Pack',     '{"uuid":"u-zero","retail_price_usd":0,"number_of_pack_slots":5}'),
  (:AD::uuid, 'D-WRONGC',   'AllDay Pack',   '{"uuid":"u-ad","retail_price_usd":9,"number_of_pack_slots":5}');

-- Weighted pools (>= 2 distinct positive weights) for everything except D-UNIFORM.
INSERT INTO public.pack_drop_pool (collection_id, dist_id, drop_weight)
SELECT collection_id, dist_id, w
FROM public.pack_distributions, unnest(ARRAY[1.0, 2.0]) AS w
WHERE dist_id <> 'D-UNIFORM';

-- ⚠ D-UNIFORM gets THREE rows all at the same weight, plus a ZERO-weight row.
-- The zero row matters: `drop_weight > 0` is inside the DISTINCT count, so
-- without it a 0 would count as a second distinct value and a uniform pool would
-- sneak through as "weighted".
INSERT INTO public.pack_drop_pool (collection_id, dist_id, drop_weight) VALUES
  (:TS::uuid, 'D-UNIFORM', 1.0),
  (:TS::uuid, 'D-UNIFORM', 1.0),
  (:TS::uuid, 'D-UNIFORM', 1.0),
  (:TS::uuid, 'D-UNIFORM', 0);

INSERT INTO public.pack_ask_state (collection_slug, dist_id, is_listed, lowest_ask) VALUES
  ('nba-top-shot', 'D-OK',       true,  20.00),
  ('nba-top-shot', 'D-ABSURD',   true,  20.00),
  ('nba-top-shot', 'D-EDGE',     true,  20.00),
  ('nba-top-shot', 'D-DELISTED', false, 20.00),
  ('nba-top-shot', 'D-SATOSHI',  true,  20.00),
  ('nba-top-shot', 'D-UNIFORM',  true,  20.00),
  ('nba-top-shot', 'D-COVERED',  true,  20.00),
  ('nba-top-shot', 'D-SENTINEL', true,  20.00),
  ('nba-top-shot', 'D-EVFAIL',   true,  20.00),
  ('nba-top-shot', 'D-NOSLOTS',  true,  20.00),
  -- ⚠ the ask lookup takes the CHEAPEST live ask (ORDER BY lowest_ask ASC), and
  -- the cheapest is the strictest denominator for the 3x cap. A second, dearer
  -- ask on D-OK pins that: at 20.00 the cap is 60, at 500.00 it would be 1500
  -- and D-ABSURD-scale EVs would sail through.
  ('nba-top-shot', 'D-OK',       true,  500.00),
  -- ⚠ and the same on D-ABSURD, which is what makes the ASC ordering observable
  -- rather than decorative: at the cheap 20.00 its 800.00 EV blows the 3x cap
  -- and is discarded; at the dear 500.00 the cap becomes 1500 and it sails
  -- through. `ORDER BY ... DESC` here would publish exactly the 40-86x badge the
  -- cap exists to stop.
  ('nba-top-shot', 'D-ABSURD',   true,  500.00),
  -- D-ZEROPRICE needs an ask for the `retail_price_usd > 0` guard to be
  -- observable at all: without one the 3x cap (NULL comparison) already excludes
  -- it, and the price guard tests nothing.
  ('nba-top-shot', 'D-ZEROPRICE',true,  20.00),
  -- another collection's slug, for the same dist_id
  ('nfl-all-day',  'D-NOASK',    true,  20.00);

INSERT INTO public.__ev_fixture (dist_id, payload) VALUES
  ('D-OK',       '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-ABSURD',   '{"ok":true,"gross_ev":800.00,"pack_ev":791.00,"is_positive_ev":true,"value_ratio":88.9,"fmv_coverage_pct":12,"edition_count":40,"typical_pull_ev":3.00}'),
  ('D-EDGE',     '{"ok":true,"gross_ev":60.00,"pack_ev":51.00,"is_positive_ev":true,"value_ratio":6.6,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-NOASK',    '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-DELISTED', '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-SATOSHI',  '{"ok":true,"gross_ev":50.00,"pack_ev":40.00,"is_positive_ev":true,"value_ratio":5.0,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-UNIFORM',  '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-COVERED',  '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-SENTINEL', '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-EVFAIL',   '{"ok":false,"error":"no priced editions"}'),
  ('D-NOSLOTS',  '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":null,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-ZEROPRICE','{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}'),
  ('D-WRONGC',   '{"ok":true,"gross_ev":50.00,"pack_ev":41.00,"is_positive_ev":true,"value_ratio":5.5,"fmv_coverage_pct":88,"edition_count":40,"typical_pull_ev":12.00}');

-- Pre-existing history: D-COVERED is genuinely covered; D-SENTINEL only has a
-- failed row, so it must still be retried.
INSERT INTO public.pack_ev_history (dist_id, collection_id, edition_count, snapshotted_at) VALUES
  ('D-COVERED',  :TS::uuid, 40, now() - interval '2 hours'),
  ('D-SENTINEL', :TS::uuid, 0,  now() - interval '2 hours');

SELECT _assert_eq(
  public.backfill_topshot_historical_pack_ev(200)::text, '5',
  'exactly the five eligible distributions are backfilled'
);

-- ── GUARD 1: the survivor-bias cap ──────────────────────────────────────────
SELECT _assert_eq(
  (SELECT gross_ev::text || '/' || pack_ev::text || '/' || is_positive_ev::text
     FROM public.pack_ev_history WHERE dist_id = 'D-OK'),
  '50.00/41.00/true',
  'a sane EV is written through with the engine''s own pack_ev / flag / ratio'
);

-- ⚠ THE MOST IMPORTANT ASSERTION IN THIS FILE. A depleted pool prices at 40-86x;
-- publishing that puts a green +EV badge on a pack that is nothing of the sort,
-- onto an unfurl seen by people who never open the page.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-ABSURD'),
  '0',
  'an EV above 3x the cheapest live ask is DISCARDED, not published'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-EDGE'),
  '1',
  'EXACTLY 3x is admitted — the cap is <=, and the boundary is where an off-by-one lives'
);

-- ── GUARD 2: no ask means no anchor, so nothing is written ──────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id IN ('D-NOASK','D-DELISTED')),
  '0',
  'with no live ask there is no sanity anchor, so the row is SKIPPED rather than published unchecked'
);

-- ── GUARD 3: the satoshi conversion ────────────────────────────────────────
SELECT _assert_eq(
  (SELECT seen_price::text FROM public.__ev_fixture WHERE dist_id = 'D-SATOSHI'),
  '10.00',
  'a retail price at/above 1000000 is divided by 1e8 — eight orders of magnitude ride on this'
);
SELECT _assert_eq(
  (SELECT seen_price::text FROM public.__ev_fixture WHERE dist_id = 'D-OK'),
  '9.00',
  '...and an ordinary price is NOT converted'
);
SELECT _assert_eq(
  (SELECT pack_price::text FROM public.pack_ev_history WHERE dist_id = 'D-SATOSHI'),
  '10.00',
  'the converted price is what gets stored, not the raw metadata value'
);

-- ── GUARD 4: weighted pools only ───────────────────────────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-UNIFORM'),
  '0',
  'a pool whose weights are all identical is not backfilled — a weighted EV over it is a uniform average'
);

-- ── GUARD 5: a sentinel row does NOT count as covered ──────────────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-COVERED'),
  '1',
  'a distribution with a fresh row carrying real editions is skipped'
);

-- ⚠ Without `COALESCE(h.edition_count,0) > 0` one failure would suppress
-- retries for 12 hours, so a pack that failed once goes unpriced for half a day.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-SENTINEL'),
  '2',
  'a distribution whose only fresh row is a SENTINEL (edition_count 0) is RETRIED'
);

-- ── GUARD 6/7: failed EV writes nothing; the flag is never NULL ────────────
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id = 'D-EVFAIL'),
  '0',
  'a failed EV computation writes NOTHING here — the opposite of the atlas sweep, deliberately'
);

SELECT _assert_eq(
  (SELECT is_positive_ev::text FROM public.pack_ev_history WHERE dist_id = 'D-NOSLOTS'),
  'false',
  'a NULL is_positive_ev from the engine is COALESCEd to false, never stored as NULL'
);

-- ── GUARD 8/9 and the slots fallback ───────────────────────────────────────
SELECT _assert_eq(
  (SELECT seen_slots::text FROM public.__ev_fixture WHERE dist_id = 'D-NOSLOTS'),
  '1',
  'an EMPTY slots string is NULLIFed and falls back to 1 — an empty string would otherwise raise 22P02'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pack_ev_history WHERE dist_id IN ('D-ZEROPRICE','D-WRONGC')),
  '0',
  'a zero retail price and another collection are both excluded from candidacy'
);

-- ── The limit floor ────────────────────────────────────────────────────────
-- ⚠ A zero or negative limit must not make the job a silent permanent no-op.
DELETE FROM public.pack_ev_history;
SELECT _assert_eq(
  public.backfill_topshot_historical_pack_ev(0)::text, '1',
  'a zero limit is floored at 1 — LIMIT 0 would make every tick a silent no-op'
);

ROLLBACK;
