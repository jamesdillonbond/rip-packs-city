-- audit_20260926_pinnacle_set_pages_find_the_catalog_spelling_of_their_set
--
-- WHY. Follow-up to 20260926171433. Every Pinnacle set page now resolves, but
-- two rendered ZERO pins, a false empty: the page's grid and stats read
-- pinnacle_catalog by `btrim(set_name) = ANY(sets_summary.set_name_variants)`,
-- and for these two the catalog spells the set differently from pinnacle_editions:
--   "Pixar Animation Studios • Luca Vol. 1"          (editions)
--   "Pixar Animation Studios • Luca Vol.1"           (catalog — same slug)
--   "Lucasfilm Ltd. • Star Wars Pinnacle Genesis"    (editions)
--   "Lucasfilm Ltd. • Star Wars Genesis"             (catalog — same royalty code)
--
-- WHAT. sets_summary.set_name_variants, for Pinnacle only, also carries the
-- catalog's spelling of the same set, found by EITHER
--   (a) the same trimmed slug, or
--   (b) the same royalty_code, ONLY where that royalty code maps to exactly one
--       catalog set name. (b)'s guard is load-bearing: SWHL is shared by Star
--       Wars Holiday Vol.1 and Vol.2, and without it Vol.1's page would list
--       Vol.2's pins.
-- Measured before applying: the rule attaches exactly these two spellings and
-- no other (176 pairs, 2 new spellings). The extra names ride only in
-- set_name_variants — edition_count, circulation and tiers are unchanged, so
-- nothing is counted twice. Every other column and every row set is identical
-- to 20260926171433.
--
-- REVERT: re-create sets_summary from 20260926171433 (its section B verbatim).

DROP MATERIALIZED VIEW public.sets_summary;

CREATE MATERIALIZED VIEW public.sets_summary AS
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
  UNION ALL
  -- Pinnacle sets that exist ONLY at catalog grain (20260926171433). Trimmed
  -- name, so the slug matches the one the site links (slugifyName trims).
  SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AS collection_id,
         regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
         btrim(pc.set_name) AS set_name,
         pc.total_minted AS circulation_count,
         pc.variant AS tier,
         CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::smallint END AS series_num,
         NULL::timestamptz AS first_minted_at,
         pc.updated_at
  FROM pinnacle_catalog pc
  WHERE pc.set_name IS NOT NULL
    AND btrim(pc.set_name) <> ALL (ARRAY['Unknown'::text, ''::text])
    AND NOT EXISTS (
      SELECT 1 FROM pinnacle_editions pe
      WHERE pe.set_name IS NOT NULL
        AND regexp_replace(lower(btrim(pe.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text)
          = regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text)
    )
),
grouped AS (
  SELECT collection_id,
         set_slug,
         (array_agg(set_name ORDER BY slug_grouped.set_name))[1] AS set_name,
         array_agg(DISTINCT set_name) AS base_variants,
         count(*) AS edition_count,
         sum(circulation_count) FILTER (WHERE circulation_count IS NOT NULL) AS total_circulation,
         array_agg(DISTINCT tier) FILTER (WHERE tier IS NOT NULL) AS tiers_present,
         min(series_num) AS min_series,
         max(series_num) AS max_series,
         min(first_minted_at) AS first_minted_at,
         max(updated_at) AS last_updated_at
  FROM slug_grouped
  GROUP BY collection_id, set_slug
),
unique_rc AS (
  SELECT pc.royalty_code
  FROM pinnacle_catalog pc
  WHERE pc.royalty_code IS NOT NULL AND pc.set_name IS NOT NULL
  GROUP BY pc.royalty_code
  HAVING count(DISTINCT btrim(pc.set_name)) = 1
),
catalog_spellings AS (
  -- Keyed by the SAME slug expression the editions branch groups on.
  SELECT regexp_replace(lower(pe.set_name), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
         array_agg(DISTINCT btrim(pc.set_name)) AS names
  FROM pinnacle_editions pe
  JOIN pinnacle_catalog pc
    ON (regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text)
          = regexp_replace(lower(btrim(pe.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text))
    OR (pc.royalty_code = pe.royalty_code AND pc.royalty_code IN (SELECT royalty_code FROM unique_rc))
  WHERE pe.set_name IS NOT NULL
    AND pe.set_name <> ALL (ARRAY['Unknown'::text, ''::text])
    AND pc.set_name IS NOT NULL
  GROUP BY 1
)
SELECT g.collection_id,
       g.set_slug,
       g.set_name,
       CASE WHEN g.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AND cs.names IS NOT NULL
            THEN ARRAY(SELECT DISTINCT v FROM unnest(g.base_variants || cs.names) v ORDER BY v)
            ELSE g.base_variants END AS set_name_variants,
       g.edition_count,
       g.total_circulation,
       g.tiers_present,
       g.min_series,
       g.max_series,
       g.first_minted_at,
       g.last_updated_at,
       now() AS computed_at
FROM grouped g
LEFT JOIN catalog_spellings cs ON cs.set_slug = g.set_slug;

CREATE UNIQUE INDEX idx_sets_summary_pk ON public.sets_summary USING btree (collection_id, set_slug);
CREATE INDEX idx_sets_summary_collection ON public.sets_summary USING btree (collection_id);
CREATE INDEX idx_sets_summary_set_name ON public.sets_summary USING btree (collection_id, set_name);

REVOKE ALL ON public.sets_summary FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sets_summary TO service_role;
