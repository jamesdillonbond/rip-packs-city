-- audit_20260902_sets_summary_ddl_recorded_from_prod
--
-- Deep-audit register R58 (residual b): `public.sets_summary` — the
-- MATERIALIZED VIEW every `/[collection]/set/[slug]` page resolves against
-- (get_set_detail reads it; refresh_sets_summary() refreshes it at 07:50Z via
-- pg_cron `rpc-refresh-sets-summary`) — existed ONLY in the live database.
-- `supabase/migrations/` carried its refresh schedule (20260704190000) and its
-- readers, but no CREATE. A load-bearing object with no DDL in the repo is
-- unrecoverable from the repo alone.
--
-- This migration is a NO-OP on production by construction: every statement is
-- IF NOT EXISTS, and the object + its three indexes already exist. It records
-- the definition read from `pg_get_viewdef('public.sets_summary')` and
-- `pg_indexes` on 2026-09-03 (833 rows at the time). Applied through
-- `apply_migration` so migration-parity sees a matching row.
--
-- ⚠ If this is ever applied to a database WITHOUT the object (a fresh
-- environment), `WITH NO DATA` leaves it empty until the first
-- `refresh_sets_summary()` — which is the same state the cron job creates
-- every morning, so nothing reads a half-built MV. Grants match prod:
-- postgres (owner) and service_role only; anon/authenticated reach it through
-- get_set_detail (SECURITY DEFINER), never directly.
--
-- REVERT: nothing to revert (no-op); to remove the record, delete this file
-- and the schema_migrations row — the object stays.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.sets_summary AS
WITH slug_grouped AS (
  SELECT editions_unified.collection_id,
         regexp_replace(lower(editions_unified.set_name), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
         editions_unified.set_name,
         editions_unified.circulation_count,
         editions_unified.tier,
         editions_unified.series_num,
         editions_unified.first_minted_at,
         editions_unified.updated_at
  FROM editions_unified
  WHERE editions_unified.set_name IS NOT NULL
    AND (editions_unified.set_name <> ALL (ARRAY['Unknown'::text, ''::text]))
)
SELECT collection_id,
       set_slug,
       (array_agg(set_name ORDER BY slug_grouped.set_name))[1] AS set_name,
       array_agg(DISTINCT set_name) AS set_name_variants,
       count(*) AS edition_count,
       sum(circulation_count) FILTER (WHERE circulation_count IS NOT NULL) AS total_circulation,
       array_agg(DISTINCT tier) FILTER (WHERE tier IS NOT NULL) AS tiers_present,
       min(series_num) AS min_series,
       max(series_num) AS max_series,
       min(first_minted_at) AS first_minted_at,
       max(updated_at) AS last_updated_at,
       now() AS computed_at
FROM slug_grouped
GROUP BY collection_id, set_slug
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sets_summary_pk ON public.sets_summary USING btree (collection_id, set_slug);
CREATE INDEX IF NOT EXISTS idx_sets_summary_collection ON public.sets_summary USING btree (collection_id);
CREATE INDEX IF NOT EXISTS idx_sets_summary_set_name ON public.sets_summary USING btree (collection_id, set_name);

-- Grants as on prod (no-op where already granted; REVOKE is deliberately not
-- issued so this file can never widen or narrow live access).
GRANT ALL ON public.sets_summary TO service_role;
