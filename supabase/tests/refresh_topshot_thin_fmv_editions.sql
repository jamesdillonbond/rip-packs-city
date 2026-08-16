-- DB invariant: public.refresh_topshot_thin_fmv_editions — pg_cron
-- `rpc-refresh-thin-fmv-guard` @ `30 8 * * *`.
--
-- WHAT IT IS. An FMV HONESTY instrument. It rebuilds the set of Top Shot
-- editions whose published FMV is inflated relative to what the market actually
-- paid: THIN (<15 sales in 90 days) AND FMV more than 1.5x the 90-day median
-- print. Those two constants ARE the definition — move either and the platform's
-- own notion of "this price is not well supported" moves with it, silently, on a
-- surface collectors read as a price.
--
-- ⚠ WHY IT NEEDS A PIN MORE THAN MOST: it TRUNCATEs and rebuilds. A rebuild that
-- inserts nothing leaves the table EMPTY, and an empty table reads exactly like
-- "no edition has an unsupported FMV" — the most reassuring possible answer,
-- produced by a broken instrument. Nothing downstream can tell the two apart.
--
-- THE PROPERTIES:
--   1. Both thresholds, asserted ON their boundaries. n_90d = 15 is NOT thin
--      (the guard is `< 15`), and FMV at exactly 1.5x the median is NOT flagged
--      (`> 1.5 *`). A fixture at 5 sales and 3x passes under any nearby constant
--      and so asserts almost nothing about either number.
--   2. The confidence prefilter: only HIGH/MEDIUM. A LOW/STALE/ASK_ONLY edition
--      is ALREADY labelled weakly supported, so re-flagging it here would be
--      redundant — and the prefilter is what keeps the median scan bounded.
--   3. It reads the LATEST snapshot per edition, not an arbitrary one.
--   4. Full rebuild: an edition that stops being inflated stops being listed.
--
-- ⚠ A real consequence of the prefilter, asserted so it stays a decision rather
-- than a surprise: `sales_count_30d BETWEEN 1 AND 14` EXCLUDES an edition with
-- ZERO 30-day sales. In practice HIGH/MEDIUM confidence implies recent sales, so
-- that cohort should be empty — but if the confidence model ever changes, a
-- zero-sale edition with an inflated FMV would be invisible to this guard.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816010000_audit_20260816_snapshot_thin_fmv_and_edition_offers_backstop.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 3e0f8218dca4bbee1ecdbeb4ee219f2b).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM
  ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE public.editions (
  id            uuid,
  collection_id uuid
);

CREATE TABLE public.fmv_snapshots (
  edition_id      uuid,
  collection_id   uuid,
  confidence      public.fmv_confidence,
  sales_count_30d integer,
  fmv_usd         numeric,
  computed_at     timestamptz
);

CREATE TABLE public.sales (
  edition_id uuid,
  price_usd  numeric,
  sold_at    timestamptz
);

CREATE TABLE public.topshot_thin_fmv_editions (
  edition_id  uuid,
  fmv_usd     numeric,
  median_90d  numeric,
  n_90d       integer,
  computed_at timestamptz
);

-- >>> BEGIN verbatim refresh_topshot_thin_fmv_editions (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_thin_fmv_editions()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.topshot_thin_fmv_editions;

  INSERT INTO public.topshot_thin_fmv_editions (edition_id, fmv_usd, median_90d, n_90d, computed_at)
  WITH cand AS (
    -- Cheap prefilter using the stored snapshot column: HIGH/MEDIUM editions that are already thin
    -- (sales_count_30d 1..14) -- narrows the median-scan set without touching the sales table.
    SELECT e.id AS edition_id, lf.fmv_usd
    FROM public.editions e
    JOIN LATERAL (
      SELECT fs.confidence, fs.sales_count_30d, fs.fmv_usd
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
        AND fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND lf.confidence IN ('HIGH','MEDIUM')
      AND lf.fmv_usd > 0
      AND lf.sales_count_30d BETWEEN 1 AND 14
  )
  SELECT c.edition_id, c.fmv_usd, m.median_90d, m.n_90d, now()
  FROM cand c
  JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd)::numeric AS median_90d,
           count(*)::integer AS n_90d
    FROM public.sales s
    WHERE s.edition_id = c.edition_id
      AND s.sold_at >= now() - interval '90 days'
      AND s.price_usd > 0
  ) m ON true
  -- Precise definition: thin (<15 sales/90d) AND FMV inflated >1.5x above the 90d median.
  WHERE m.n_90d < 15
    AND m.median_90d > 0
    AND c.fmv_usd > 1.5 * m.median_90d;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
-- <<< END verbatim refresh_topshot_thin_fmv_editions <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set flagged '''aaaaaaaa-0000-0000-0000-000000000001'''
\set atbound '''aaaaaaaa-0000-0000-0000-000000000002'''
\set thick '''aaaaaaaa-0000-0000-0000-000000000003'''
\set lowconf '''aaaaaaaa-0000-0000-0000-000000000004'''
\set exactly15 '''aaaaaaaa-0000-0000-0000-000000000005'''

INSERT INTO public.editions (id, collection_id) VALUES
  (:flagged::uuid, :TS::uuid),
  (:atbound::uuid, :TS::uuid),
  (:thick::uuid, :TS::uuid),
  (:lowconf::uuid, :TS::uuid),
  (:exactly15::uuid, :TS::uuid);

-- Latest snapshot per edition. `flagged` also gets an OLDER snapshot that would
-- NOT qualify, to prove the `ORDER BY computed_at DESC LIMIT 1` really picks the
-- newest rather than an arbitrary row.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, confidence, sales_count_30d, fmv_usd, computed_at) VALUES
  (:flagged::uuid,   :TS::uuid, 'HIGH',   5,  300, now() - interval '1 hour'),
  (:flagged::uuid,   :TS::uuid, 'HIGH',   5,   50, now() - interval '10 days'),
  (:atbound::uuid,   :TS::uuid, 'MEDIUM', 5,  150, now()),
  (:thick::uuid,     :TS::uuid, 'HIGH',   5,  300, now()),
  (:lowconf::uuid,   :TS::uuid, 'LOW',    5,  300, now()),
  (:exactly15::uuid, :TS::uuid, 'HIGH',   5,  300, now());

-- flagged   :  3 sales, median 100, FMV 300 = 3.0x  -> FLAG
-- atbound   :  3 sales, median 100, FMV 150 = 1.5x  -> NOT flagged (strict >)
-- thick     : 20 sales, median 100                  -> NOT flagged (not thin)
-- lowconf   : same as flagged but LOW confidence    -> NOT flagged (prefilter)
-- exactly15 : 15 sales, median 100, FMV 300         -> NOT flagged (strict <)
INSERT INTO public.sales (edition_id, price_usd, sold_at)
  SELECT :flagged::uuid, 100, now() - interval '5 days' FROM generate_series(1,3);
INSERT INTO public.sales (edition_id, price_usd, sold_at)
  SELECT :atbound::uuid, 100, now() - interval '5 days' FROM generate_series(1,3);
INSERT INTO public.sales (edition_id, price_usd, sold_at)
  SELECT :thick::uuid, 100, now() - interval '5 days' FROM generate_series(1,20);
INSERT INTO public.sales (edition_id, price_usd, sold_at)
  SELECT :lowconf::uuid, 100, now() - interval '5 days' FROM generate_series(1,3);
INSERT INTO public.sales (edition_id, price_usd, sold_at)
  SELECT :exactly15::uuid, 100, now() - interval '5 days' FROM generate_series(1,15);

-- A stale row from a previous run: it must not survive the TRUNCATE.
INSERT INTO public.topshot_thin_fmv_editions (edition_id, fmv_usd, median_90d, n_90d, computed_at)
  VALUES (:thick::uuid, 999, 1, 1, now() - interval '1 day');

SELECT _assert_eq(
  public.refresh_topshot_thin_fmv_editions()::text, '1',
  'exactly one edition is thin AND inflated'
);

SELECT _assert_eq(
  (SELECT edition_id::text FROM public.topshot_thin_fmv_editions), :flagged,
  'and it is the 3-sale, 3x-median edition'
);

SELECT _assert_eq(
  (SELECT fmv_usd::text FROM public.topshot_thin_fmv_editions), '300',
  'the LATEST snapshot is used, not the older one that would not qualify'
);

SELECT _assert_eq(
  (SELECT median_90d::text FROM public.topshot_thin_fmv_editions), '100',
  'the 90d median print is recorded alongside the FMV'
);

-- ⚠ BOTH THRESHOLDS ON THE BOUNDARY. A fixture at 5 sales and 3x passes under
-- any nearby constant; these are the only two fixtures that pin 1.5 and 15.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_thin_fmv_editions WHERE edition_id = :atbound::uuid),
  '0',
  'FMV at EXACTLY 1.5x the median is not flagged — the guard is a strict >'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_thin_fmv_editions WHERE edition_id = :exactly15::uuid),
  '0',
  'EXACTLY 15 sales in 90d is not thin — the guard is a strict <'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_thin_fmv_editions WHERE edition_id = :lowconf::uuid),
  '0',
  'a LOW-confidence edition is already labelled weak and is not re-flagged here'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_thin_fmv_editions WHERE edition_id = :thick::uuid),
  '0',
  'the stale row from a previous run did not survive the TRUNCATE'
);

-- ── Full rebuild: an edition that stops being inflated stops being listed ────
-- ⚠ This is what the TRUNCATE is FOR, and the property nothing downstream can
-- verify: an empty table and a broken instrument look identical from outside.
UPDATE public.fmv_snapshots SET fmv_usd = 110
  WHERE edition_id = :flagged::uuid AND computed_at > now() - interval '2 hours';

SELECT _assert_eq(
  public.refresh_topshot_thin_fmv_editions()::text, '0',
  'an edition whose FMV comes back in line is forgotten on the next rebuild'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.topshot_thin_fmv_editions), '0',
  'and the table is emptied rather than appended to'
);

ROLLBACK;
