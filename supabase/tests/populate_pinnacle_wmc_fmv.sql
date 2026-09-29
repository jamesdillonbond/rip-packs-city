-- DB invariant: public.populate_pinnacle_wmc_fmv — copies the Pinnacle
-- catalog's per-pin FMV onto wallet_moments_cache, the column the Collection
-- page totals. Added 2026-09-28: it skipped pins the catalog de-priced, so a
-- NO_DATA pin kept its last price in every wallet that held it.
--
-- Claims:
--   1. A priced catalog pin fills a NULL wallet row and re-prices a stale one.
--   2. A catalog pin with NO price (NO_DATA) sets the wallet row back to NULL
--      and is reported as `cleared`.
--   3. After a draining run, a pin going to NULL alone (the priced-row
--      watermark does not move) still triggers a scan and clears the row.
--   4. A row in another collection with the same moment_id is untouched.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929021346_audit_20260928_pinnacle_wmc_fmv_follows_the_catalog_to_null.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.pinnacle_catalog (render_id text PRIMARY KEY, fmv_usd numeric, fmv_computed_at timestamptz);
CREATE TABLE public.populate_pinnacle_wmc_fmv_state (id int PRIMARY KEY, synced_catalog_fmv_at timestamptz, synced_at timestamptz);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, moment_id text, collection_id uuid,
  render_id text, edition_key text, fmv_usd numeric,
  PRIMARY KEY (wallet_address, collection_id, moment_id)
);

CREATE OR REPLACE FUNCTION public.populate_pinnacle_wmc_fmv(p_limit integer DEFAULT 5000)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_collection_id uuid; v_updated int := 0; v_examined int := 0; v_cleared int := 0;
  v_catalog_max timestamptz; v_synced timestamptz; v_has_work boolean;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = 'disney_pinnacle';

  -- 2026-08-30 watermark: skip the ~55k-row scan when the catalog has not
  -- moved since the last draining run and no out-of-sync row is waiting.
  -- 2026-09-28: "out of sync" includes a priced wallet row over a pin the
  -- catalog no longer prices (NO_DATA) — the probe below looks for both.
  SELECT max(fmv_computed_at) INTO v_catalog_max
  FROM pinnacle_catalog WHERE fmv_usd IS NOT NULL;
  SELECT synced_catalog_fmv_at INTO v_synced
  FROM populate_pinnacle_wmc_fmv_state WHERE id = 1;
  IF v_synced IS NOT NULL AND v_catalog_max IS NOT NULL AND v_catalog_max <= v_synced THEN
    SELECT EXISTS (
      SELECT 1
      FROM wallet_moments_cache w
      JOIN pinnacle_catalog pc ON pc.render_id = w.render_id
      WHERE w.collection_id = v_collection_id
        AND w.render_id IS NOT NULL
        AND ((w.fmv_usd IS NULL AND w.edition_key IS NOT NULL AND pc.fmv_usd IS NOT NULL)
          OR (w.fmv_usd IS NOT NULL AND pc.fmv_usd IS NULL))
    ) INTO v_has_work;
    IF NOT v_has_work THEN
      RETURN json_build_object('examined', 0, 'updated', 0, 'cleared', 0,
        'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0',
        'reason', 'catalog_unchanged', 'catalog_fmv_max', v_catalog_max);
    END IF;
  END IF;

  -- 2026-09-28: the catalog's price is the wallet's price, INCLUDING its
  -- absence. A pin the catalog no longer prices (NO_DATA) is set back to NULL;
  -- this writer used to skip those rows, so the last price stuck forever
  -- (339 pins / 20 wallets / $9,705 on 09-28) and the Collection total
  -- disagreed with Analytics, which reads the catalog.
  WITH candidates AS (
    SELECT wmc.wallet_address, wmc.moment_id, wmc.collection_id, pc.fmv_usd AS new_fmv
    FROM wallet_moments_cache wmc
    JOIN pinnacle_catalog pc ON pc.render_id = wmc.render_id
    WHERE wmc.collection_id = v_collection_id
      AND wmc.render_id IS NOT NULL
      AND wmc.fmv_usd IS DISTINCT FROM pc.fmv_usd
    LIMIT p_limit
  ),
  upd AS (
    UPDATE wallet_moments_cache wmc SET fmv_usd = c.new_fmv
    FROM candidates c
    WHERE wmc.wallet_address = c.wallet_address AND wmc.moment_id = c.moment_id
      AND wmc.collection_id = c.collection_id
    RETURNING wmc.moment_id, c.new_fmv
  )
  SELECT (SELECT COUNT(*) FROM candidates), (SELECT COUNT(*) FROM upd),
         (SELECT COUNT(*) FROM upd WHERE new_fmv IS NULL)
    INTO v_examined, v_updated, v_cleared;

  -- Drained: everything the catalog max at the start of this run implied is
  -- now synced. A run that hit its limit leaves the watermark for the next.
  IF v_examined < COALESCE(p_limit, 5000) AND v_catalog_max IS NOT NULL THEN
    INSERT INTO populate_pinnacle_wmc_fmv_state (id, synced_catalog_fmv_at, synced_at)
    VALUES (1, v_catalog_max, now())
    ON CONFLICT (id) DO UPDATE SET synced_catalog_fmv_at = EXCLUDED.synced_catalog_fmv_at,
                                   synced_at = EXCLUDED.synced_at;
  END IF;

  RETURN json_build_object('examined', v_examined, 'updated', v_updated, 'cleared', v_cleared,
    'collection', 'disney_pinnacle', 'algo', 'render-catalog-2.0',
    'reason', 'scanned', 'catalog_fmv_max', v_catalog_max);
END;
$function$;

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set OTHER '''11111111-1111-1111-1111-111111111111'''
INSERT INTO public.collections VALUES (:PIN::uuid, 'disney_pinnacle'), (:OTHER::uuid, 'nba_top_shot');
INSERT INTO public.pinnacle_catalog VALUES
  ('r-priced', 12.50, '2026-09-28 10:00+00'),
  ('r-nodata', NULL,  '2026-09-28 10:00+00'),
  ('r-later',  8.00,  '2026-09-28 10:00+00');
INSERT INTO public.wallet_moments_cache VALUES
  ('0xa', 'm1', :PIN::uuid, 'r-priced', 'e1', NULL),   -- fill
  ('0xa', 'm2', :PIN::uuid, 'r-priced', 'e1', 99.00),  -- re-price
  ('0xa', 'm3', :PIN::uuid, 'r-nodata', 'e2', 40.00),  -- clear
  ('0xa', 'm4', :PIN::uuid, 'r-later',  'e3', 8.00),   -- already in sync
  ('0xa', 'm3', :OTHER::uuid, 'r-nodata', 'e2', 40.00); -- other collection

-- Claims 1, 2, 4
SELECT public.populate_pinnacle_wmc_fmv(100)->>'cleared' AS run1_cleared \gset
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE moment_id = 'm1'), '12.50', 'a NULL row is filled');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE moment_id = 'm2'), '12.50', 'a stale price is replaced');
SELECT _assert((SELECT fmv_usd IS NULL FROM public.wallet_moments_cache WHERE moment_id = 'm3' AND collection_id = :PIN::uuid), 'a de-priced pin goes back to NULL');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE moment_id = 'm3' AND collection_id = :OTHER::uuid), '40.00', 'another collection''s row is untouched');
SELECT _assert_eq(:'run1_cleared', '1', 'the NO_DATA pin is reported cleared');

-- Claim 3: drained; now ONLY a priced pin goes to NULL.
SELECT _assert_eq((public.populate_pinnacle_wmc_fmv(100)->>'reason'), 'catalog_unchanged', 'a drained, unchanged catalog exits early');
UPDATE public.pinnacle_catalog SET fmv_usd = NULL, fmv_computed_at = '2026-09-28 11:00+00' WHERE render_id = 'r-later';
SELECT public.populate_pinnacle_wmc_fmv(100)->>'reason' AS run3_reason \gset
SELECT _assert((SELECT fmv_usd IS NULL FROM public.wallet_moments_cache WHERE moment_id = 'm4'), 'the newly de-priced pin is cleared');
SELECT _assert_eq(:'run3_reason', 'scanned', 'a pin going to NULL moves the watermark');

-- Claim 3b: an out-of-sync priced wallet row over an unpriced pin is found even
-- when the watermark has not moved.
UPDATE public.wallet_moments_cache SET fmv_usd = 5 WHERE moment_id = 'm4';
SELECT public.populate_pinnacle_wmc_fmv(100)->>'cleared' AS run4_cleared \gset
SELECT _assert((SELECT fmv_usd IS NULL FROM public.wallet_moments_cache WHERE moment_id = 'm4'), 'the early-exit probe sees a priced row over an unpriced pin');
SELECT _assert_eq(:'run4_cleared', '1', 'the probe-triggered run reports it cleared');

SELECT '✓ populate_pinnacle_wmc_fmv: all assertions passed' AS result;

ROLLBACK;
