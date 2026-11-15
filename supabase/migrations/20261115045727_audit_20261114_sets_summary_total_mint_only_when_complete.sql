-- audit_20261114_sets_summary_total_mint_only_when_complete
--
-- WHY (Claude Code cloud, 2026-11-14 ~8:47 PM PT). sets_summary (the set pages' name-keyed read, refreshed
-- hourly by pg_cron 37 at :50) summed circulation over the editions whose count is KNOWN and published it
-- as the set's "Total Mint": 280 Candy editions carry no circulation, so 223 Candy set pages showed a
-- partial total as the total (live: "2022 Leadoff ICONs" 2,201,213 with 7 of its 2,165 editions uncounted).
-- Same class as get_player_detail / get_set_detail / get_team_* / series rollup fixed in 20261115043933 and
-- the companion function migration. first_minted_at gets the same all-rows rule (a MIN over the dated few
-- is not the first mint).
--
-- WHAT. The view definition is the live pg_get_viewdef (md5 1cfc716271e731624abcbd75d9589e74) with two
-- aggregate replacements; the CASE ELSE is an untyped NULL so both columns keep their types (get_set_detail
-- reads a RECORD whose types must match across calls). Built under a new name WITH DATA (~25 s) while the
-- old view keeps serving, then swapped by RENAME so readers wait only for the rename. Same three
-- indexes (the unique one is what REFRESH ... CONCURRENTLY needs), same ACL (postgres + service_role only).
-- Measured on the new definition before the apply: 3,541 rows, 237 NULL totals (223 Candy), 4 dated.
--
-- APPLIED 2026-11-14 8:57 PM PT (version 20261115045727) on Trevor's "Apply the rename version". Verified: definition
-- md5 e093bda0…, 3,541 rows, 237 NULL totals, canonical index names, ACL unchanged on both copies; refresh_sets_summary()
-- ran clean at 8:58:15 PM PT; rendered /candy-mlb/set/2022-leadoff-icons Total Mint "—" (was 2,201,213), control
-- /nba-top-shot/set/base-set 38,556,319. The parked sets_summary_prev_20261114 (2.7 MB, not refreshed) awaits removal.
--
-- REVERT: swap back by RENAME (sets_summary -> sets_summary_next, sets_summary_prev_20261114 -> sets_summary,
-- and the same for the three indexes), or recreate the view from the md5-1cfc7162 definition (this file's guard names it; it is the
-- `sum(...) FILTER (WHERE ... IS NOT NULL)` / `min(first_minted_at)` form) the same way.

SET LOCAL statement_timeout = '180s';

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.sets_summary'::regclass)) IS DISTINCT FROM '1cfc716271e731624abcbd75d9589e74' THEN
    RAISE EXCEPTION 'sets_summary definition changed since this was written -- re-read and re-splice';
  END IF;
END
$guard$;

CREATE MATERIALIZED VIEW public.sets_summary_next AS
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
          WHERE ((editions_unified.set_name IS NOT NULL) AND (editions_unified.set_name <> ALL (ARRAY['Unknown'::text, ''::text])))
        UNION ALL
         SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AS collection_id,
            regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
            btrim(pc.set_name) AS set_name,
            pc.total_minted AS circulation_count,
            pc.variant AS tier,
                CASE
                    WHEN (pc.series_name ~ '^[0-9]{4}$'::text) THEN (pc.series_name)::smallint
                    ELSE NULL::smallint
                END AS series_num,
            NULL::timestamp with time zone AS first_minted_at,
            pc.updated_at
           FROM pinnacle_catalog pc
          WHERE ((pc.set_name IS NOT NULL) AND (btrim(pc.set_name) <> ALL (ARRAY['Unknown'::text, ''::text])) AND (NOT (EXISTS ( SELECT 1
                   FROM pinnacle_editions pe
                  WHERE ((pe.set_name IS NOT NULL) AND (regexp_replace(lower(btrim(pe.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text) = regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text)))))))
        UNION ALL
         SELECT e.collection_id,
            regexp_replace(lower(e.set_name), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
            e.set_name,
            e.circulation_count,
            (e.tier)::text AS tier,
            e.series AS series_num,
            e.first_minted_at,
            e.updated_at
           FROM editions e
          WHERE ((e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid) AND (e.set_name IS NOT NULL) AND (e.set_name <> ALL (ARRAY['Unknown'::text, ''::text])) AND (NOT (EXISTS ( SELECT 1
                   FROM collections c
                  WHERE ((c.id = e.collection_id) AND (c.is_active IS TRUE))))))
        ), grouped AS (
         SELECT slug_grouped.collection_id,
            slug_grouped.set_slug,
            (array_agg(slug_grouped.set_name ORDER BY slug_grouped.set_name))[1] AS set_name,
            array_agg(DISTINCT slug_grouped.set_name) AS base_variants,
            count(*) AS edition_count,
            CASE WHEN (count(*) = count(slug_grouped.circulation_count)) THEN sum(slug_grouped.circulation_count) ELSE NULL END AS total_circulation,
            array_agg(DISTINCT slug_grouped.tier) FILTER (WHERE (slug_grouped.tier IS NOT NULL)) AS tiers_present,
            min(slug_grouped.series_num) AS min_series,
            max(slug_grouped.series_num) AS max_series,
            CASE WHEN (count(*) = count(slug_grouped.first_minted_at)) THEN min(slug_grouped.first_minted_at) ELSE NULL END AS first_minted_at,
            max(slug_grouped.updated_at) AS last_updated_at
           FROM slug_grouped
          GROUP BY slug_grouped.collection_id, slug_grouped.set_slug
        ), unique_rc AS (
         SELECT pc.royalty_code
           FROM pinnacle_catalog pc
          WHERE ((pc.royalty_code IS NOT NULL) AND (pc.set_name IS NOT NULL))
          GROUP BY pc.royalty_code
         HAVING (count(DISTINCT btrim(pc.set_name)) = 1)
        ), catalog_spellings AS (
         SELECT regexp_replace(lower(pe.set_name), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
            array_agg(DISTINCT btrim(pc.set_name)) AS names
           FROM (pinnacle_editions pe
             JOIN pinnacle_catalog pc ON (((regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text) = regexp_replace(lower(btrim(pe.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text)) OR ((pc.royalty_code = pe.royalty_code) AND (pc.royalty_code IN ( SELECT unique_rc.royalty_code
                   FROM unique_rc))))))
          WHERE ((pe.set_name IS NOT NULL) AND (pe.set_name <> ALL (ARRAY['Unknown'::text, ''::text])) AND (pc.set_name IS NOT NULL))
          GROUP BY (regexp_replace(lower(pe.set_name), '[^a-z0-9]+'::text, '-'::text, 'g'::text))
        )
 SELECT g.collection_id,
    g.set_slug,
    g.set_name,
        CASE
            WHEN ((g.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid) AND (cs.names IS NOT NULL)) THEN ARRAY( SELECT DISTINCT v.v
               FROM unnest((g.base_variants || cs.names)) v(v)
              ORDER BY v.v)
            ELSE g.base_variants
        END AS set_name_variants,
    g.edition_count,
    g.total_circulation,
    g.tiers_present,
    g.min_series,
    g.max_series,
    g.first_minted_at,
    g.last_updated_at,
    now() AS computed_at
   FROM (grouped g
     LEFT JOIN catalog_spellings cs ON ((cs.set_slug = g.set_slug)))
WITH DATA;

CREATE UNIQUE INDEX idx_sets_summary_next_pk ON public.sets_summary_next USING btree (collection_id, set_slug);
CREATE INDEX idx_sets_summary_next_collection ON public.sets_summary_next USING btree (collection_id);
CREATE INDEX idx_sets_summary_next_set_name ON public.sets_summary_next USING btree (collection_id, set_name);

-- No deletion: the old view is parked under a dated name (the Supabase connector holds any deletion for a
-- confirmation that could not reach the operator twice). Its indexes are renamed first so the new
-- view's indexes can take the canonical names. Cleanup of the parked copy is a separate step.
ALTER INDEX public.idx_sets_summary_pk RENAME TO idx_sets_summary_prev_20261114_pk;
ALTER INDEX public.idx_sets_summary_collection RENAME TO idx_sets_summary_prev_20261114_collection;
ALTER INDEX public.idx_sets_summary_set_name RENAME TO idx_sets_summary_prev_20261114_set_name;
ALTER MATERIALIZED VIEW public.sets_summary RENAME TO sets_summary_prev_20261114;
ALTER MATERIALIZED VIEW public.sets_summary_next RENAME TO sets_summary;
ALTER INDEX public.idx_sets_summary_next_pk RENAME TO idx_sets_summary_pk;
ALTER INDEX public.idx_sets_summary_next_collection RENAME TO idx_sets_summary_collection;
ALTER INDEX public.idx_sets_summary_next_set_name RENAME TO idx_sets_summary_set_name;

REVOKE ALL ON public.sets_summary FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sets_summary TO service_role;

DO $post$
BEGIN
  IF has_table_privilege('anon', 'public.sets_summary', 'SELECT') OR has_table_privilege('authenticated', 'public.sets_summary', 'SELECT') THEN
    RAISE EXCEPTION 'sets_summary became readable by anon/authenticated';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sets_summary', 'SELECT') THEN
    RAISE EXCEPTION 'service_role lost sets_summary';
  END IF;
  IF (SELECT count(*) FROM pg_index WHERE indrelid = 'public.sets_summary'::regclass) <> 3 THEN
    RAISE EXCEPTION 'sets_summary index count is not 3';
  END IF;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.sets_summary'::regclass AND attname = 'total_circulation')
     IS DISTINCT FROM 'bigint' THEN
    RAISE EXCEPTION 'sets_summary.total_circulation type changed';
  END IF;
END
$post$;
