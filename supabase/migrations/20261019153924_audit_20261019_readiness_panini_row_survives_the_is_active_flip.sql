-- audit_20261019_readiness_panini_row_survives_the_is_active_flip
--
-- Found by the 10-19 reader audit of collections.is_active (known-issues #64): the
-- Panini readiness row (20261019151137) was gated on `is_active = false`, so the flip
-- would have DROPPED it and Panini would have fallen into the Flow probe over `sales`
-- (sales_24h 0, thin_volume true, last_sale_at NULL) — a false thin-volume notice.
-- Now: the helper returns the row regardless of the flag, and the Flow probe excludes
-- Panini by slug. No output change today (verified as anon after apply).
--
-- anon-exec: unchanged (panini_readiness_row) — CREATE OR REPLACE of an existing fn; ACL preserved, allowlisted 20261019151201.
-- anon-exec: unchanged (readiness_collection_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=true.
--
-- Revert: re-apply both bodies from 20261019151137.

CREATE OR REPLACE FUNCTION public.panini_readiness_row()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
           'slug', c.slug,
           'name', c.name,
           'sales_24h', NULL::int,
           'thin_volume', NULL::boolean,
           'last_sale_at', public.panini_newest_recorded_sale_at())
    FROM public.collections c
   WHERE c.slug = 'panini_blockchain';
$function$;

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
      AND c.slug <> 'panini_blockchain'   -- Panini's row comes only from panini_readiness_row()
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
  -- ⚠ The WHOLE row comes from a SECDEF helper: this function is SECURITY
  -- INVOKER, anon has no SELECT on panini_sales, and anon's RLS on
  -- `collections` shows only is_active rows — so an inline arm either 500s or
  -- silently returns nothing for the only real caller.
  panini_row AS (
    SELECT r->>'slug' AS slug, r AS row
      FROM (SELECT public.panini_readiness_row() AS r) x
     WHERE r IS NOT NULL
  )
  SELECT COALESCE(
    jsonb_agg(u.row ORDER BY u.slug),
    '[]'::jsonb
  )
  FROM (SELECT * FROM flow_rows UNION ALL SELECT * FROM panini_row) u;
$function$;
