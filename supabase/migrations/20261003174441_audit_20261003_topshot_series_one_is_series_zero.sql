-- audit_20261003_topshot_series_one_is_series_zero
--
-- Top Shot stores series as the on-chain UInt32 verbatim: Series 1 IS 0, and
-- there is NO series 1 on chain (docs/reference/database.md "Series map";
-- app/api/cron/topshot-set-series-onchain verified `TopShot.getSetSeries(1)`
-- → 0 through Flow REST; `collection_series` has rows 0,2,3,4,5,6,7,8 and no 1).
--
-- Yet `sets.series = 1` on all 23 Series-1 sets (set_id_onchain 2–25), and
-- every writer that copies a set's series onto its editions carried it:
-- `editions.series = 1` on 378 rows across those 23 sets (each set ALSO has
-- series-0 editions — Run It Back 25:358 is 0, 25:337 is 1), `badge_editions
-- .series_number = 1` on 375, `wallet_moments_cache.series_number = 1` on
-- 2,012. Measured 2026-10-03: 100 % of all four populations sit inside the 23
-- sets; zero rows with value 1 exist outside them. The views
-- topshot_set_squeeze_board / topshot_special_serial_owners derive from these.
--
-- User-visible: a beta tester's Detroit Pistons team checklist showed Series 1
-- as 2 Rare + 8 Common (the series-0 rows) instead of 6 Legendary + 9 Rare +
-- 8 Common (0 ∪ 1 = exactly his 23). Every "Series 1" filter that resolves
-- through collection_series (→ 0) drops the series-1 rows the same way.
-- known-issues #168.
--
-- Scope: Top Shot ONLY (collection_id 95f28a17-224a-4025-96ad-adf8a4c63bfd).
-- ⛔ This is NOT the 2026-08-05 blanket `1 → 0` remap that dropped 385,734
-- rows: All Day / Golazos / Pinnacle use 1 legitimately and UFC has both.
-- `topshot_ipfs_assets.series` is a separate 1-based convention (1..8, no 0)
-- and is deliberately NOT touched.
--
-- Writer pinned: the on-chain cron writes 0 for any future Series-1 set and
-- fills editions from `sets` fill-only; the catalog migrations copy `s.series`;
-- editions-hydrate copies a sibling edition's series. With `sets` at 0 none of
-- them can re-create a 1. check_topshot_series_orphans() reports any recurrence.
--
-- Revert (data): UPDATE public.sets s SET series = 1 FROM audit_20261003_ts_series1_sets a WHERE a.id = s.id;
--   UPDATE public.editions e SET series = 1 FROM audit_20261003_ts_series1_editions a WHERE a.id = e.id;
--   UPDATE public.badge_editions b SET series_number = 1 FROM audit_20261003_ts_series1_badge_editions a WHERE a.id = b.id;
--   UPDATE public.wallet_moments_cache w SET series_number = 1 FROM audit_20261003_ts_series1_wmc a WHERE a.id = w.id;
--   DROP FUNCTION public.check_topshot_series_orphans();

-- ── backups (RLS on, no policy = service_role only, like every audit_ table) ──
CREATE TABLE public.audit_20261003_ts_series1_sets AS
  SELECT id, set_id_onchain, name, series, now() AS backed_up_at
  FROM public.sets
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series = 1;
ALTER TABLE public.audit_20261003_ts_series1_sets ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.audit_20261003_ts_series1_editions AS
  SELECT id, external_id, set_name, series, now() AS backed_up_at
  FROM public.editions
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series = 1;
ALTER TABLE public.audit_20261003_ts_series1_editions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.audit_20261003_ts_series1_badge_editions AS
  SELECT id, external_id, series_number, now() AS backed_up_at
  FROM public.badge_editions
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series_number = 1;
ALTER TABLE public.audit_20261003_ts_series1_badge_editions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.audit_20261003_ts_series1_wmc AS
  SELECT id, edition_key, series_number, now() AS backed_up_at
  FROM public.wallet_moments_cache
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series_number = 1;
ALTER TABLE public.audit_20261003_ts_series1_wmc ENABLE ROW LEVEL SECURITY;

-- ── the fix: 1 → 0, Top Shot only ─────────────────────────────────────────────
UPDATE public.sets
   SET series = 0
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series = 1;

UPDATE public.editions
   SET series = 0
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series = 1;

UPDATE public.badge_editions
   SET series_number = 0
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series_number = 1;

UPDATE public.wallet_moments_cache
   SET series_number = 0
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series_number = 1;

-- ── the instrument: any Top Shot row that reads series 1 again ───────────────
-- Returns a jsonb ARRAY of {table, rows}; `[]` is the clean state. Cheap:
-- four counts on indexed collection_id filters.
CREATE OR REPLACE FUNCTION public.check_topshot_series_orphans()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', t, 'rows', n) ORDER BY t), '[]'::jsonb)
  FROM (
    SELECT 'sets' AS t, count(*) AS n FROM public.sets
      WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series = 1
    UNION ALL
    SELECT 'editions', count(*) FROM public.editions
      WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series = 1
    UNION ALL
    SELECT 'badge_editions', count(*) FROM public.badge_editions
      WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series_number = 1
    UNION ALL
    SELECT 'wallet_moments_cache', count(*) FROM public.wallet_moments_cache
      WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND series_number = 1
  ) x
  WHERE n > 0;
$$;

-- anon-exec: revoked (check_topshot_series_orphans) — new SECURITY DEFINER read; EXECUTE revoked from PUBLIC, anon, authenticated in the statement below and granted to postgres + service_role only.
REVOKE EXECUTE ON FUNCTION public.check_topshot_series_orphans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_topshot_series_orphans() TO postgres, service_role;
