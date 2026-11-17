-- audit_20261019_readiness_panini_arm_lag_aware
--
-- #64 residue, rollup 2 of 5 (search was 1, 10-14): `readiness_collection_stats`
-- gains a Panini row WITHOUT flipping `collections.is_active`.
--
-- Why a separate arm and not the is_active flip: Panini sales live in
-- `panini_sales`, never in `sales` (0 rows, ever), so the shared probe would
-- publish `sales_24h = 0, thin_volume = true` — a FALSE "thin volume" notice on
-- a market that settles at ~400–2,700 sales a day.
--
-- Why the 24 h count is NULL and not a number (measured 10-18, panini.md Next 5):
-- Panini sales reach `panini_sales` a median 12–160 h after `sold_at` (the
-- laptop runner's walk age), so a 24 h `sold_at` probe UNDERSTATES (7 rows on a
-- ~400+ day), and `first_seen_at` OVERSTATES (it counts history the walk finds
-- late: 16,325 rows first seen in 24 h). Neither column measures 24 h volume.
-- So: `sales_24h` NULL and `thin_volume` NULL — UNKNOWN, which the Market and
-- Analytics clients read as "no notice" (`thin_volume === true` only).
-- `last_sale_at` = the newest RECORDED Panini sale in 7 days — honest under
-- the lag (it can only be older than the truth, never newer).
--
-- Every other row is byte-for-byte the previous body (20260823072000).
--
-- anon-exec: unchanged (readiness_collection_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=true before (the route is anon-reachable by design, returns no user data).
--
-- Revert: re-apply the function body from 20260823072000_audit_20260823_readiness_bounded_probe.sql.

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
  -- Panini arm (#64): independent of is_active; lag-aware (see header).
  panini_row AS (
    SELECT c.slug,
      jsonb_build_object(
        'slug', c.slug,
        'name', c.name,
        'sales_24h', NULL::int,
        'thin_volume', NULL::boolean,
        'last_sale_at',
          (SELECT max(ps.sold_at) FROM public.panini_sales ps
            WHERE ps.sold_at > now() - interval '7 days'
              AND ps.sold_at <= now())
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
