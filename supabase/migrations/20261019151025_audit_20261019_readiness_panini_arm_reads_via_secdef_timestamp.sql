-- audit_20261019_readiness_panini_arm_reads_via_secdef_timestamp
--
-- 🚨 FIX for 20261019145232 (same session, ~8:20 AM PT): readiness_collection_stats
-- is SECURITY INVOKER and `anon` has NO SELECT on public.panini_sales (RLS on,
-- service-role only — it carries collector usernames), so the Panini arm raised
-- permission denied for every anon caller and /api/ready returned 500 from
-- ~7:52 AM PT. My verification ran as postgres, which is why it looked clean.
--
-- Fix: a narrow SECURITY DEFINER helper that returns ONE timestamp (the newest
-- recorded Panini sale in 7 days) and nothing else; anon may EXECUTE it because
-- its whole output is a single public-safe value. The readiness function calls
-- it instead of reading the table.
--
-- anon-exec: granted (panini_newest_recorded_sale_at) — new SECDEF fn returning one timestamptz, no rows/usernames; needed by the anon-reachable /api/ready.
-- anon-exec: unchanged (readiness_collection_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=true.
--
-- Revert: re-apply 20261019145232's body is NOT a revert (it 500s); revert both by
-- re-applying the body of 20260823072000 and `DROP FUNCTION public.panini_newest_recorded_sale_at();`.

CREATE OR REPLACE FUNCTION public.panini_newest_recorded_sale_at()
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT max(ps.sold_at) FROM public.panini_sales ps
   WHERE ps.sold_at > now() - interval '7 days'
     AND ps.sold_at <= now();
$function$;

REVOKE EXECUTE ON FUNCTION public.panini_newest_recorded_sale_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_newest_recorded_sale_at() TO anon, authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.readiness_collection_stats()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH probe AS (
    SELECT
      c.id,
      c.slug,
      c.name,
      -- ⚠ BOUNDED AT 11, NOT COUNTED. The only consumer semantic is
      -- `sales_24h < 10`, and 11 rows answer that EXACTLY. Counting the real
      -- 24 h volume cost ~8,000 buffers / ~340 DISK READS and measured
      -- 4,863 ms as postgres and 24,523 ms as anon on a QUIET instance, against
      -- an 8 s anon ceiling — so /api/ready 500'd on essentially every request.
      -- This probe: 24 buffers, 3 reads, 63 ms.
      (SELECT count(*) FROM (
         SELECT 1 FROM public.sales s
          WHERE s.collection_id = c.id
            AND s.sold_at > now() - interval '24 hours'
          LIMIT 11) t) AS n,
      (SELECT max(s.sold_at) FROM public.sales s
        WHERE s.collection_id = c.id
          AND s.sold_at > now() - interval '7 days') AS last_sale,
      (SELECT count(*) FROM (
         SELECT 1 FROM public.pinnacle_sales ps
          WHERE ps.sold_at > now() - interval '24 hours'
          LIMIT 11) t) AS pinn_n,
      (SELECT max(ps.sold_at) FROM public.pinnacle_sales ps
        WHERE ps.sold_at > now() - interval '7 days') AS pinn_last
    FROM public.collections c
    WHERE c.is_active = true
  ),
  flow_rows AS (
    SELECT p.slug,
      jsonb_build_object(
        'slug', p.slug,
        'name', p.name,
        -- ⚠ EXACT when it is small, NULL when it is merely "more than 10".
        -- Returning `least(n, 11)` would publish a fabricated count; returning
        -- null says what we actually know. `thin_volume` carries the answer the
        -- consumers need, so nothing downstream has to infer it from a number.
        'sales_24h',
          CASE WHEN (CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_n ELSE p.n END) <= 10
               THEN (CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_n ELSE p.n END)
               ELSE NULL END,
        'thin_volume',
          (CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_n ELSE p.n END) < 10,
        'last_sale_at',
          CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_last ELSE p.last_sale END
      ) AS row
    FROM probe p
  ),
  -- Panini arm (#64): independent of is_active; lag-aware (20261019145232).
  -- ⚠ Reads panini_sales ONLY through the SECDEF timestamp helper: this function
  -- is SECURITY INVOKER and anon has no SELECT on panini_sales.
  panini_row AS (
    SELECT c.slug,
      jsonb_build_object(
        'slug', c.slug,
        'name', c.name,
        'sales_24h', NULL::int,
        'thin_volume', NULL::boolean,
        'last_sale_at', public.panini_newest_recorded_sale_at()
      ) AS row
    FROM public.collections c
    WHERE c.slug = 'panini_blockchain'
      AND c.is_active = false
  )
  SELECT COALESCE(
    jsonb_agg(u.row ORDER BY u.slug),
    '[]'::jsonb
  )
  FROM (SELECT * FROM flow_rows UNION ALL SELECT * FROM panini_row) u;
$function$;
