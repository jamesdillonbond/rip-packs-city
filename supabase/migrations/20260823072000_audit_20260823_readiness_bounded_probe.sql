-- audit_20260823_readiness_bounded_probe
--
-- ── WHY: the 60 s edge cache was a MITIGATION and it did not work ───────────
-- Caching the SUCCESS path cuts origin hits only if a request ever succeeds. It
-- did not: measured 2026-08-23 with the instance QUIET (5 active backends, 6 IO
-- waiters — NOT a saturation spell), `readiness_collection_stats()` took
-- **4,863 ms as postgres and 24,523 ms as anon** on ~8,000 buffers of which
-- ~340 are DISK READS this instance serves at 10-40 ms each. The anon path is
-- bound by `authenticator`'s 8 s, so every request missed, 500'd, and a 500 is
-- never cached — so the cache had nothing to serve and /api/ready 500'd three
-- times out of three.
-- ⚠ The 24,523 ms run BEAT a `SET LOCAL statement_timeout = '8s'` — the
-- recorded "statement_timeout overshoots under IO throttle: best-effort, not a
-- cap". And my earlier headline of "10.9 ms warm" was the fully-cached case.
--
-- ── THE FIX: stop counting ─────────────────────────────────────────────────
-- The ONLY consumer semantic is `sales_24h < 10`. A probe bounded to 11 rows
-- answers that EXACTLY. Measured: **24 buffers, 3 reads, 63 ms** — ~330x fewer
-- buffers and ~100x fewer disk reads than the count it replaces.
--
-- ⚠ `sales_24h` IS NOW A BOUNDED PROBE, NOT A VOLUME FIGURE: exact when <= 10,
-- **NULL above**. Returning `least(n, 11)` would have been a fabricated count.
-- `thin_volume` carries the answer, so nothing downstream has to infer it from
-- a number whose meaning changed.
--
-- 🚨 THE CLIENT CHANGE IS NOT OPTIONAL AND SHIPS WITH THIS. The old expression
-- `(sales_24h ?? 0) < 10` coerces the new NULL to 0 and renders
-- "THIN-VOLUME ECOSYSTEM" on Top Shot — the loudest possible false claim about
-- the market, produced by a performance fix. Both clients now read
-- `thin_volume === true`; `=== true` is deliberate, because null means UNKNOWN
-- and unknown must not assert thin (the boolean form of the `?? 0` defect).
-- Pinned by regression controls in component-MarketClient and
-- component-CollectionAnalyticsClient, both proven to redden against the old
-- expression.
--
-- Revert: restore the body from 20260823021500 (the full-count version) AND
--         `git revert` the client commit — they must move together.

CREATE OR REPLACE FUNCTION public.readiness_collection_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH probe AS (
    SELECT
      c.id, c.slug, c.name,
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
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'slug', p.slug,
        'name', p.name,
        'sales_24h',
          CASE WHEN (CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_n ELSE p.n END) <= 10
               THEN (CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_n ELSE p.n END)
               ELSE NULL END,
        'thin_volume',
          (CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_n ELSE p.n END) < 10,
        'last_sale_at',
          CASE WHEN p.slug = 'disney_pinnacle' THEN p.pinn_last ELSE p.last_sale END
      )
      ORDER BY p.slug
    ),
    '[]'::jsonb
  )
  FROM probe p;
$fn$;

COMMENT ON FUNCTION public.readiness_collection_stats() IS
  'Anon-safe readiness slice for /api/ready. ⚠ sales_24h is a BOUNDED PROBE: exact when <= 10, NULL above (never a fabricated cap). `thin_volume` is the answer the two consumers actually need. Bounding it took the read from ~8,000 buffers / 340 disk reads / 4.9-24.5 s to 24 buffers / 3 reads / 63 ms, which is what stopped the route 500ing against the 8 s anon ceiling. Deliberately SECURITY INVOKER. ⛔ Do not widen it to carry user counts, telemetry or db_size (deep-audit R44).';

REVOKE ALL ON FUNCTION public.readiness_collection_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_collection_stats() TO anon, authenticated, service_role;
