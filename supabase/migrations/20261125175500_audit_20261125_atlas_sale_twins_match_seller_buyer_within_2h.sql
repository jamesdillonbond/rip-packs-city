-- audit_20261125_atlas_sale_twins_match_seller_buyer_within_2h
-- ✅ APPLIED 2026-11-26 ~10:55 AM PT (recorded version 20261126185403) from Cowork: 231 twins found, 231 retired and archived, anon EXECUTE false.
--
-- Trevor 11-25 ("Yes do it all and update everything"), found checking the Wednesday rookie post.
-- MEASURED 2026-11-25 ~9:50 AM PT: 231 Top Shot sales are stored twice, as an `atlas` row (no tx hash)
-- plus the on-chain row for the same sale: same nft, same price, same seller, same buyer, the two rows
-- 10.1–93.4 min apart (median ~28). 155 from the 10-29 catch-up after the Dapper outage, 7 from 11-23,
-- the rest older. `retire_topshot_atlas_sale_twins` (20261010053000) matches a twin only within ±10 min,
-- so it retires none of them (old rule on the same population: 0). One inflated the 2026 rookie class
-- total by a $19 sale (Christian Anderson Jr., 11-23 7:11 PM PT).
--
-- THE FIX: the lateral also accepts a non-Atlas row with a tx hash at the same price up to ±2 h away
-- when it has the SAME seller and SAME buyer and no other sale of that moment lies between the two
-- (a resale back and forth inside 2 h would put a row between them). The ±10-min price-only rule is
-- unchanged. Everything else in the body is the 20261010053000 body verbatim (prosrc md5
-- 3c9eaf9bad69540acf80f44b596b2c90 verified against that file before writing this one).
-- Then one all-time sweep (p_days 3000) retires the 231; each deleted row is archived whole in
-- flowty_archive.audit_topshot_atlas_sale_twins as before.
--
-- REVERT:
--   re-apply the function body from 20261010053000 (CREATE OR REPLACE only, the cron job is unchanged);
--   restore rows: INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, a.row)).*
--     FROM flowty_archive.audit_topshot_atlas_sale_twins a WHERE a.retired_at >= '2026-11-25';

CREATE OR REPLACE FUNCTION public.retire_topshot_atlas_sale_twins(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_coll     constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_examined int := 0;
  v_twins    int := 0;
  v_retired  int := 0;
  v_repoint  int := 0;
  v_n        int := 0;
  v_err      text;
BEGIN
  BEGIN
    -- Atlas rows in the window, each with the closest non-Atlas row for the same sale (if any).
    DROP TABLE IF EXISTS _atw;
    CREATE TEMP TABLE _atw ON COMMIT DROP AS
    SELECT a.id AS atlas_id, a.sold_at AS atlas_sold_at, t.id AS twin_id, t.source AS twin_source
      FROM public.sales a
      LEFT JOIN LATERAL (
        SELECT o.id, o.source
          FROM public.sales o
         WHERE o.collection_id = v_coll
           AND o.nft_id = a.nft_id
           AND o.sold_at BETWEEN a.sold_at - interval '2 hours' AND a.sold_at + interval '2 hours'
           AND o.source IS DISTINCT FROM 'atlas'
           AND o.transaction_hash IS NOT NULL
           AND o.price_usd = a.price_usd
           -- ±10 min on price alone (the original rule), or up to ±2 h when the SAME seller sold to the
           -- SAME buyer and no other sale of the moment sits between the two rows (20261125: the
           -- 10-29 and 11-23 catch-ups landed their on-chain rows 10–93 min from the Atlas row).
           AND (o.sold_at BETWEEN a.sold_at - interval '10 minutes' AND a.sold_at + interval '10 minutes'
                OR (o.seller_address = a.seller_address
                    AND o.buyer_address = a.buyer_address
                    AND NOT EXISTS (
                      SELECT 1 FROM public.sales m
                       WHERE m.collection_id = v_coll
                         AND m.nft_id = a.nft_id
                         AND m.id <> a.id AND m.id <> o.id
                         AND m.sold_at BETWEEN LEAST(a.sold_at, o.sold_at) AND GREATEST(a.sold_at, o.sold_at))))
         ORDER BY abs(extract(epoch FROM o.sold_at - a.sold_at)), o.id
         LIMIT 1) t ON true
     WHERE a.collection_id = v_coll
       AND a.source = 'atlas'
       AND a.transaction_hash IS NULL
       AND a.sold_at > now() - make_interval(days => p_days);
    SELECT count(*), count(twin_id) INTO v_examined, v_twins FROM _atw;
    DELETE FROM _atw WHERE twin_id IS NULL;

    -- A parked copy resolved onto the Atlas row follows the sale to the row that survives.
    UPDATE public.unmapped_sales u SET resolved_sale_id = w.twin_id
      FROM _atw w WHERE u.resolved_sale_id = w.atlas_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_repoint := v_n;
    UPDATE public.sales_ingest_unresolved u SET resolved_sale_id = w.twin_id
      FROM _atw w WHERE u.resolved_sale_id = w.atlas_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_repoint := v_repoint + v_n;

    -- Delete and archive in ONE statement: the archive holds exactly the rows that left `sales`.
    WITH d AS (
      DELETE FROM public.sales s
       USING _atw w
       WHERE s.id = w.atlas_id
         AND s.collection_id = v_coll
         AND s.sold_at = w.atlas_sold_at
         AND s.source = 'atlas'
         AND s.transaction_hash IS NULL
      RETURNING s.*)
    INSERT INTO flowty_archive.audit_topshot_atlas_sale_twins (sale_id, twin_id, twin_source, row)
    SELECT d.id, w.twin_id, w.twin_source, to_jsonb(d)
      FROM d JOIN _atw w ON w.atlas_id = d.id;
    GET DIAGNOSTICS v_retired = ROW_COUNT;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    v_retired := 0;
    v_repoint := 0;
  END;

  PERFORM public.log_pipeline_run(
    'topshot-atlas-twin-retire', v_started, v_twins, v_retired, v_examined - v_twins,
    v_err IS NULL AND v_retired = v_twins, COALESCE(v_err,
      CASE WHEN v_retired <> v_twins THEN v_twins || ' twin(s) found, ' || v_retired || ' retired' END),
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('window_days', p_days, 'atlas_rows_examined', v_examined, 'twins_found', v_twins,
                       'retired', v_retired, 'references_repointed', v_repoint, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('window_days', p_days, 'atlas_rows_examined', v_examined, 'twins_found', v_twins,
                            'retired', v_retired, 'references_repointed', v_repoint, 'error', v_err);
END $$;

-- anon-exec: unchanged (retire_topshot_atlas_sale_twins) — CREATE OR REPLACE of an existing fn; ACL preserved (service_role + postgres only).

SELECT public.retire_topshot_atlas_sale_twins(3000);
