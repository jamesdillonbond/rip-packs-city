-- audit_20260924_get_pack_metrics_sales_from_onchain_pack_purchases
--
-- get_pack_metrics() counted Top Shot / All Day pack sales from Dapper's studio
-- index, which carries only DAPPER_MARKETPLACE sales (42% of Top Shot on a
-- settled day) and stamps each row with its LISTING time. So `sales_24h` read
-- 458 against 1,278 on-chain secondary sales, and `sale_ingest_lag_min` (168–396
-- min) mostly measured how long packs sat listed, not our ingest delay.
--
-- FIX: the two arms now read pack_purchases (event_kind 'secondary_sale',
-- sale-timestamped); lag = median(created_at - sealed_at) over rows ingested in
-- the last 24 h. Golazos / Candy arms unchanged. Applied as an ASSERTED in-DB
-- replace of the live prosrc (each old arm must occur exactly once), so no other
-- part of the body can drift; the header is rebuilt from the live signature.
--
-- anon-exec: NOT granted — get_pack_metrics keeps its signature and its
-- REVOKE-from-PUBLIC/anon/authenticated ACL (CREATE OR REPLACE preserves it).
--
-- REVERT: the inverse replace (swap new_ts/new_ad back to old_ts/old_ad below).

DO $mig$
DECLARE
  v_src text;
  v_new text;
  old_ts text := $o1$    SELECT 'nba-top-shot'::text AS slug,
           count(*) FILTER (WHERE h.block_time > now() - interval '24 hours')::int AS s24,
           count(*) FILTER (WHERE h.block_time > now() - interval '7 days')::int AS s7,
           max(h.block_time) AS newest,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM h.ingested_at - h.block_time)/60)
                   FILTER (WHERE h.ingested_at > now() - interval '24 hours' AND h.block_time > now() - interval '48 hours'))::numeric, 1) AS lag
      FROM public.topshot_pack_sales_history h WHERE h.block_time > now() - interval '8 days'$o1$;
  new_ts text := $n1$    SELECT 'nba-top-shot'::text AS slug,
           count(*) FILTER (WHERE p.sealed_at > now() - interval '24 hours')::int AS s24,
           count(*) FILTER (WHERE p.sealed_at > now() - interval '7 days')::int AS s7,
           max(p.sealed_at) AS newest,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.created_at - p.sealed_at)/60)
                   FILTER (WHERE p.created_at > now() - interval '24 hours'))::numeric, 1) AS lag
      FROM public.pack_purchases p
     WHERE p.collection_id = v_ts AND p.event_kind = 'secondary_sale' AND p.sealed_at > now() - interval '8 days'$n1$;
  old_ad text := $o2$    SELECT 'nfl-all-day', count(*) FILTER (WHERE h.block_time > now() - interval '24 hours')::int,
           count(*) FILTER (WHERE h.block_time > now() - interval '7 days')::int, max(h.block_time),
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM h.ingested_at - h.block_time)/60)
                   FILTER (WHERE h.ingested_at > now() - interval '24 hours' AND h.block_time > now() - interval '48 hours'))::numeric, 1)
      FROM public.allday_pack_sales_history h WHERE h.block_time > now() - interval '8 days'$o2$;
  new_ad text := $n2$    SELECT 'nfl-all-day', count(*) FILTER (WHERE p.sealed_at > now() - interval '24 hours')::int,
           count(*) FILTER (WHERE p.sealed_at > now() - interval '7 days')::int, max(p.sealed_at),
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.created_at - p.sealed_at)/60)
                   FILTER (WHERE p.created_at > now() - interval '24 hours'))::numeric, 1)
      FROM public.pack_purchases p
     WHERE p.collection_id = v_ad AND p.event_kind = 'secondary_sale' AND p.sealed_at > now() - interval '8 days'$n2$;
BEGIN
  SELECT prosrc INTO STRICT v_src FROM pg_proc WHERE oid = 'public.get_pack_metrics()'::regprocedure;
  IF (length(v_src) - length(replace(v_src, old_ts, ''))) / length(old_ts) <> 1 THEN
    RAISE EXCEPTION 'get_pack_metrics: Top Shot sales arm not found exactly once';
  END IF;
  IF (length(v_src) - length(replace(v_src, old_ad, ''))) / length(old_ad) <> 1 THEN
    RAISE EXCEPTION 'get_pack_metrics: All Day sales arm not found exactly once';
  END IF;
  v_new := replace(replace(v_src, old_ts, new_ts), old_ad, new_ad);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.get_pack_metrics()
RETURNS %s
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS %L$f$, pg_get_function_result('public.get_pack_metrics()'::regprocedure), v_new);
END
$mig$;
