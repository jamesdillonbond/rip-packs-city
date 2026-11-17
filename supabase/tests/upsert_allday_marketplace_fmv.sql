-- DB invariant: public.upsert_allday_marketplace_fmv — the AllDay marketplace →
-- FMV writer (the All Day parallel to the pinned upsert_topshot_marketplace_fmv).
-- It turns scraped AllDay marketplace rows (lowest ask, average sale, listing
-- count) into fmv_snapshots, but ONLY under honesty gates: it must never write an
-- edition whose LATEST snapshot is HIGH/MEDIUM confidence (a sales-derived FMV is
-- never clobbered by a marketplace-derived one), it caps a troll ask at $5,000,
-- it grades avg-sale-backed rows LOW and ask-only rows ASK_ONLY, and it
-- delete-then-inserts only TODAY's snapshot so history accretes. It reports
-- (upserted, skipped, no_edition).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql),
-- verified byte-identical to the live prod definition via pg_get_functiondef on
-- 2026-07-31. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE public.fmv_confidence AS ENUM
  ('HIGH','MEDIUM','LOW','NO_DATA','ASK_ONLY','SALES_ONLY','STALE');

CREATE TABLE public.editions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid,
  external_id   text
);
CREATE TABLE public.fmv_snapshots (
  edition_id           uuid,
  collection_id        uuid,
  fmv_usd              numeric,
  floor_price_usd      numeric,
  asp_usd              numeric,
  asp_without_outliers numeric,
  confidence           fmv_confidence,
  listing_count        integer,
  ask_proxy_fmv        numeric,
  cross_market_ask     numeric,
  algo_version         text,
  computed_at          timestamptz,
  collection           text,
  sales_count_7d       integer,
  sales_count_30d      integer
);

-- >>> BEGIN verbatim upsert_allday_marketplace_fmv (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.upsert_allday_marketplace_fmv(p_rows jsonb)
 RETURNS TABLE(upserted integer, skipped integer, no_edition integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id  uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid;
  v_ask_ceiling    numeric := 5000;
  v_upserted       int := 0;
  v_no_edition     int := 0;
  v_skipped        int := 0;
  v_today_start    timestamptz := date_trunc('day', NOW());
  v_today_end      timestamptz := date_trunc('day', NOW()) + INTERVAL '1 day';
BEGIN
  DROP TABLE IF EXISTS _input_rows;
  CREATE TEMP TABLE _input_rows ON COMMIT DROP AS
  SELECT
    COALESCE(elem->>'edition_flow_id', elem->>'editionFlowID')::text AS ext_id,
    NULLIF(COALESCE(elem->>'lowest_price', elem->>'lowestPrice'), '')::numeric  AS low_price,
    NULLIF(COALESCE(elem->>'average_sale', elem->>'averageSale'), '')::numeric  AS avg_sale,
    COALESCE(
      NULLIF(elem->>'total_listings', '')::int,
      NULLIF(elem->>'totalListings', '')::int,
      0
    ) AS total_list
  FROM jsonb_array_elements(p_rows) AS elem;

  DROP TABLE IF EXISTS _mapped_rows;
  CREATE TEMP TABLE _mapped_rows ON COMMIT DROP AS
  SELECT
    e.id AS edition_id,
    i.low_price,
    i.avg_sale,
    i.total_list
  FROM _input_rows i
  JOIN editions e
    ON  e.collection_id = v_collection_id
    AND e.external_id   = i.ext_id
  WHERE i.ext_id IS NOT NULL;

  v_no_edition := (
    SELECT COUNT(*) FROM _input_rows WHERE ext_id IS NULL
  ) + (
    SELECT COUNT(*) FROM _input_rows i
    WHERE i.ext_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM editions e
        WHERE e.collection_id = v_collection_id AND e.external_id = i.ext_id
      )
  );

  DROP TABLE IF EXISTS _eligible_rows;
  CREATE TEMP TABLE _eligible_rows ON COMMIT DROP AS
  SELECT m.*
  FROM _mapped_rows m
  LEFT JOIN LATERAL (
    SELECT fs.confidence::text AS conf
    FROM fmv_snapshots fs
    WHERE fs.edition_id = m.edition_id
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) latest ON true
  WHERE (latest.conf IS NULL OR latest.conf NOT IN ('HIGH','MEDIUM'));

  v_skipped := (SELECT COUNT(*) FROM _mapped_rows) - (SELECT COUNT(*) FROM _eligible_rows);

  DROP TABLE IF EXISTS _writes;
  CREATE TEMP TABLE _writes ON COMMIT DROP AS
  SELECT
    e.edition_id,
    CASE WHEN e.avg_sale IS NOT NULL AND e.avg_sale > 0 THEN e.avg_sale
         ELSE e.low_price
    END AS fmv_usd,
    e.low_price,
    e.avg_sale,
    e.total_list,
    CASE WHEN e.avg_sale IS NOT NULL AND e.avg_sale > 0 THEN 'LOW'::fmv_confidence
         ELSE 'ASK_ONLY'::fmv_confidence
    END AS confidence
  FROM _eligible_rows e
  WHERE
    (e.avg_sale IS NOT NULL AND e.avg_sale > 0)
    OR (e.low_price IS NOT NULL AND e.low_price > 0 AND e.low_price <= v_ask_ceiling);

  v_skipped := v_skipped + ((SELECT COUNT(*) FROM _eligible_rows) - (SELECT COUNT(*) FROM _writes));

  IF EXISTS (SELECT 1 FROM _writes) THEN
    DELETE FROM fmv_snapshots fs
    USING _writes w
    WHERE fs.edition_id    = w.edition_id
      AND fs.collection_id = v_collection_id
      AND fs.computed_at  >= v_today_start
      AND fs.computed_at  <  v_today_end;

    INSERT INTO fmv_snapshots (
      edition_id, collection_id, fmv_usd, floor_price_usd,
      asp_usd, asp_without_outliers,
      confidence, listing_count,
      ask_proxy_fmv, cross_market_ask,
      algo_version, computed_at, collection,
      sales_count_7d, sales_count_30d
    )
    SELECT
      w.edition_id, v_collection_id,
      w.fmv_usd, w.low_price,
      CASE WHEN w.avg_sale > 0 THEN w.avg_sale ELSE NULL END,
      CASE WHEN w.avg_sale > 0 THEN w.avg_sale ELSE NULL END,
      w.confidence, w.total_list,
      w.low_price, w.low_price,
      'allday-gql-v1', NOW(), 'nfl_all_day',
      0, 0
    FROM _writes w;

    GET DIAGNOSTICS v_upserted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_upserted, v_skipped, v_no_edition;
END;
$function$;
-- <<< END verbatim upsert_allday_marketplace_fmv <<<

\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''

-- Editions A1..A5 map; A9 has no editions row (→ no_edition).
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('a1111111-1111-1111-1111-111111111111', :ad::uuid, 'A1'),  -- eligible, avg 50 → LOW 50
  ('a2222222-2222-2222-2222-222222222222', :ad::uuid, 'A2'),  -- eligible, ask 30 only → ASK_ONLY 30
  ('a3333333-3333-3333-3333-333333333333', :ad::uuid, 'A3'),  -- latest HIGH → PROTECTED (skipped)
  ('a4444444-4444-4444-4444-444444444444', :ad::uuid, 'A4'),  -- ask 9999 > ceiling → skipped
  ('a5555555-5555-5555-5555-555555555555', :ad::uuid, 'A5');  -- eligible; has today+yesterday snaps

-- A3 latest snapshot is HIGH (the value this writer must NOT overwrite).
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at, collection)
VALUES ('a3333333-3333-3333-3333-333333333333', :ad::uuid, 250, 'HIGH', now(), 'nfl_all_day');
-- A5 has a LOW snapshot today (to be replaced) and a LOW one yesterday (to survive).
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at, collection) VALUES
  ('a5555555-5555-5555-5555-555555555555', :ad::uuid, 10, 'LOW', date_trunc('day', now()) + interval '1 hour', 'nfl_all_day'),
  ('a5555555-5555-5555-5555-555555555555', :ad::uuid,  5, 'LOW', date_trunc('day', now()) - interval '3 hours', 'nfl_all_day');

-- Drive the writer.
CREATE TEMP TABLE _res AS
SELECT * FROM public.upsert_allday_marketplace_fmv(jsonb_build_array(
  jsonb_build_object('edition_flow_id','A1','average_sale','50','lowest_price','48','total_listings',3),
  jsonb_build_object('edition_flow_id','A2','lowest_price','30','total_listings',1),
  jsonb_build_object('edition_flow_id','A3','average_sale','99','lowest_price','80','total_listings',2),
  jsonb_build_object('edition_flow_id','A4','lowest_price','9999','total_listings',1),
  jsonb_build_object('edition_flow_id','A5','average_sale','40','lowest_price','38','total_listings',4),
  jsonb_build_object('edition_flow_id','A9','average_sale','12','total_listings',1),
  jsonb_build_object('lowest_price','7','total_listings',1)   -- no edition id at all
));

-- ── Return tuple: (upserted, skipped, no_edition) = (3, 2, 2) ────────────────
SELECT _assert_eq((SELECT upserted::text FROM _res),  '3', 'upserted = A1 + A2 + A5');
SELECT _assert_eq((SELECT skipped::text  FROM _res),  '2', 'skipped = A3 (HIGH-protected) + A4 (over ceiling)');
SELECT _assert_eq((SELECT no_edition::text FROM _res),'2', 'no_edition = A9 (unmapped) + the id-less row');

-- ── A1: avg-sale-backed → LOW confidence, fmv = avg_sale ─────────────────────
SELECT _assert_eq((SELECT confidence::text FROM public.fmv_snapshots
  WHERE edition_id='a1111111-1111-1111-1111-111111111111'), 'LOW',
  'an average-sale-backed row is graded LOW, not ASK_ONLY');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id='a1111111-1111-1111-1111-111111111111'), '50',
  'fmv = average sale when it is positive');

-- ── A2: ask-only → ASK_ONLY confidence, fmv = lowest ask ────────────────────
SELECT _assert_eq((SELECT confidence::text FROM public.fmv_snapshots
  WHERE edition_id='a2222222-2222-2222-2222-222222222222'), 'ASK_ONLY',
  'an ask-only row is graded ASK_ONLY');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id='a2222222-2222-2222-2222-222222222222'), '30',
  'fmv = lowest ask when there is no positive average sale');

-- ── A3: HIGH-confidence edition is untouched (the core honesty gate) ─────────
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id='a3333333-3333-3333-3333-333333333333'), '1',
  'a HIGH-confidence edition gets no new snapshot — never overwritten');
SELECT _assert_eq((SELECT confidence::text FROM public.fmv_snapshots
  WHERE edition_id='a3333333-3333-3333-3333-333333333333'), 'HIGH',
  'the protected edition still reads HIGH');

-- ── A4: ask above the $5,000 ceiling, no avg sale → nothing written ─────────
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id='a4444444-4444-4444-4444-444444444444'), '0',
  'a troll ask above the $5,000 ceiling is skipped');

-- ── A5: today replaced (fmv now 40), yesterday preserved (history accretes) ──
SELECT _assert_eq((SELECT count(*)::text FROM public.fmv_snapshots
  WHERE edition_id='a5555555-5555-5555-5555-555555555555'), '2',
  'delete-then-insert TODAY only: yesterday''s snapshot survives (2 rows total)');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.fmv_snapshots
  WHERE edition_id='a5555555-5555-5555-5555-555555555555'
    AND computed_at >= date_trunc('day', now())), '40',
  'today''s snapshot was replaced with the fresh fmv (40), old 10 gone');

SELECT '✓ upsert_allday_marketplace_fmv invariants pass' AS result;
ROLLBACK;
