-- ⏸ HELD — NOT APPLIED (2026-10-09 ~9:57 PM PT). It deletes 485 production `sales` rows, and the
-- auto-mode classifier holds unattended production deletes while Trevor travels. Apply on his go-ahead:
-- paste the whole file into the Supabase SQL editor (or apply_migration with this exact name). It is
-- safe to run once; a second run finds no twins. Verify after: the final SELECT returns
-- {"twins_found": 485, "retired": 485, "error": null}, and
-- SELECT count(*) FROM flowty_archive.audit_topshot_atlas_sale_twins  -- 485
--
-- audit_20261009: a Top Shot `atlas` sale is retired once the on-chain indexer's row for the SAME sale lands
-- after it -- the Atlas lane's ±10-min dedupe held in one direction only.
--
-- MEASURED 2026-10-09 ~9:55 PM PT. `sync_sales_from_atlas` (20260907233444) writes an Atlas listing sale
-- (source 'atlas', NO transaction_hash -- Atlas does not carry one) only when no `sales` row for the same
-- nft exists within ±10 min, and it waits 2 h so the on-chain indexer's row is normally there first. But
-- when the indexer is down longer than 2 h, its CATCH-UP inserts the on-chain row AFTER the Atlas row, and
-- nothing dedupes in that direction. 485 Top Shot sales are stored twice this way, all time: 436 from the
-- 09-10 catch-up (on-chain rows ingested 3–4 PM PT, the Atlas twins 9:36 AM – 4:36 PM PT) and 49 from the
-- 09-18 one (the #122 outage). Every pair: same nft, same price, same buyer, median 2.5 s apart, the
-- on-chain row carries the tx hash. Both rows are in `sales_market`, so each of those sales counts TWICE in
-- the FMV inputs until 10-18, when the last pair leaves the 30-day window, and twice forever in the
-- all-time readers. The #68 detector `check_topshot_dupe_sales` cannot see them: it groups by
-- transaction_hash, and an Atlas row has none. Nothing references the 485 Atlas row ids (no FK on `sales`;
-- `unmapped_sales` / `sales_ingest_unresolved` .resolved_sale_id: 0 rows).
--
-- THE FIX. `retire_topshot_atlas_sale_twins(p_days)` deletes an `atlas` row (Top Shot, NULL tx hash,
-- sold in the last p_days) when a non-Atlas row with a tx hash exists for the same nft at the SAME price
-- within ±10 min: the lane's own rule, made two-sided, plus a price match so a different sale of the same
-- moment inside 10 min is never taken for a twin (30 such rows exist all time; none is touched). Each
-- deleted row is copied whole, as jsonb, into flowty_archive.audit_topshot_atlas_sale_twins in the same
-- statement, with the id of the row that superseded it; references in unmapped_sales /
-- sales_ingest_unresolved are re-pointed to that row first. pg_cron `rpc-topshot-atlas-twin-retire` runs it
-- every 6 h at :47 over 7 days (an indexer catch-up lands within hours; 7 d covers a weekend outage).
-- Measured: the 40-day form is ~115k buffers / 1.2 s (per-row LATERAL probe on sales_<year>_nft_id_idx,
-- run-time partition pruning); 7 days is about a sixth of that. This migration runs the 40-day form once.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-atlas-twin-retire');
--   INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, a.row)).*
--     FROM flowty_archive.audit_topshot_atlas_sale_twins a;
--   DROP FUNCTION public.retire_topshot_atlas_sale_twins(integer);
--   (keep the audit table until the restore is verified, then DROP TABLE flowty_archive.audit_topshot_atlas_sale_twins)

CREATE TABLE IF NOT EXISTS flowty_archive.audit_topshot_atlas_sale_twins (
  retired_at  timestamptz NOT NULL DEFAULT now(),
  sale_id     uuid        NOT NULL,
  twin_id     uuid        NOT NULL,
  twin_source text,
  row         jsonb       NOT NULL
);
REVOKE ALL ON flowty_archive.audit_topshot_atlas_sale_twins FROM PUBLIC, anon, authenticated;

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
           AND o.sold_at BETWEEN a.sold_at - interval '10 minutes' AND a.sold_at + interval '10 minutes'
           AND o.source IS DISTINCT FROM 'atlas'
           AND o.transaction_hash IS NOT NULL
           AND o.price_usd = a.price_usd
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

-- anon-exec: revoked (retire_topshot_atlas_sale_twins) — a new SECDEF fn that DELETEs sales rows; service_role + postgres only.
REVOKE EXECUTE ON FUNCTION public.retire_topshot_atlas_sale_twins(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_topshot_atlas_sale_twins(integer) TO postgres, service_role;

SELECT cron.schedule('rpc-topshot-atlas-twin-retire', '47 */6 * * *',
                     $cmd$ SELECT public.retire_topshot_atlas_sale_twins(7) $cmd$);

-- The one-off sweep over everything the Atlas lane has written inside the FMV window and before.
SELECT public.retire_topshot_atlas_sale_twins(40);
