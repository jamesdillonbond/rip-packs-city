-- Unique index is REQUIRED for REFRESH MATERIALIZED VIEW CONCURRENTLY, which is what
-- keeps readers unblocked during the refresh. Verified unique before creating:
-- 172 rows / 172 distinct (collection_slug, external_id), zero NULLs in either column.
-- Not CONCURRENTLY: the MV was created in this same migration series and has no
-- concurrent readers yet, so the plain form is correct here (and CONCURRENTLY cannot
-- run inside apply_migration's transaction anyway).
CREATE UNIQUE INDEX mv_cross_collection_deals_key
  ON public.mv_cross_collection_deals (collection_slug, external_id);

-- ⚠ REVOKE explicitly rather than relying on "we never granted it". This database
-- carries BOTH a PUBLIC default and ALTER DEFAULT PRIVILEGES grants, so a new relation
-- can arrive already readable by anon/authenticated without anyone writing a GRANT.
-- Revoke FROM PUBLIC, anon, authenticated in one statement per the standing rule.
REVOKE ALL ON public.mv_cross_collection_deals FROM PUBLIC, anon, authenticated;

-- House pattern, verified against all 20 existing materialized views in this schema:
-- every one is service_role-only (anon SELECT false, authenticated SELECT false).
-- All four readers of this board are service_role — app/api/public/insights/deals
-- (supabaseAdmin), app/api/support-chat (SUPABASE_SERVICE_ROLE_KEY),
-- app/api/cron/topshot-deal-floor-serials (supabaseAdmin) and
-- lib/insights/boards.ts fetchDealsDefault (supabaseAdmin default) — so nothing reads
-- this as anon and the wrapper view keeps its existing grants untouched.
GRANT SELECT ON public.mv_cross_collection_deals TO postgres, service_role;
