-- audit_20260927_panini_sets_reach_the_set_pages
--
-- WHY. Panini's 62 WC Prizm sets had no sets_summary row, so /panini-blockchain/set/<slug>
-- could not resolve: sets_summary builds from editions_unified, which admits only collections
-- with is_active = true, and Panini stays inactive BY DECISION (known-issues #64 — the flip
-- would enroll it in sales-fed rollups over a `sales` table holding zero Panini rows).
-- get_set_detail and get_set_editions read `editions` directly once sets_summary names the set,
-- and Panini's bridged `editions` rows (5,101, absolute media URLs since 20260927180515) are
-- complete, so ONE arm here is the whole fix.
--
-- WHAT. A Panini arm over `editions` (NOT panini_editions — that arm in editions_unified maps
-- `nation` into team_name, and a nation is not a team). It turns itself off if Panini is ever
-- activated. Every other row is unchanged: the definition below is 20260926171737 verbatim plus
-- that arm, and the post-apply block asserts the non-Panini row set did not move.
--
-- sets_summary's readers (pg_proc grep 2026-09-27): get_set_detail, get_set_editions,
-- get_set_alias_target, refresh_sets_summary. No view depends on it.
--
-- REVERT: re-apply 20260926171737 (its body verbatim).

-- Refresh first, so the before/after comparison measures THIS change, not whatever moved since
-- the 00:50 PT daily refresh (the job takes 0.2–16 s).
REFRESH MATERIALIZED VIEW public.sets_summary;

CREATE TEMP TABLE _sets_summary_before AS
  SELECT collection_id, set_slug, edition_count FROM public.sets_summary;

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
  UNION ALL
  -- Panini WC Prizm sets (2026-09-27), from the BRIDGED `editions` rows. Panini
  -- stays collections.is_active = false by decision (known-issues #64), so the
  -- is_active-gated editions_unified above never carries it. This arm switches
  -- itself OFF if Panini is ever activated: editions_unified would then carry it
  -- (twice — its editions AND panini_editions arms), and a third copy here would
  -- only add to that.
  SELECT e.collection_id,
         regexp_replace(lower(e.set_name), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
         e.set_name,
         e.circulation_count,
         e.tier::text AS tier,
         e.series AS series_num,
         e.first_minted_at,
         e.updated_at
  FROM editions e
  WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
    AND e.set_name IS NOT NULL
    AND e.set_name <> ALL (ARRAY['Unknown'::text, ''::text])
    AND NOT EXISTS (
      SELECT 1 FROM collections c
      WHERE c.id = e.collection_id AND c.is_active IS TRUE
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

DO $verify$
DECLARE
  v_panini int;
  v_diff int;
BEGIN
  SELECT count(*) INTO v_panini FROM public.sets_summary
   WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  IF v_panini < 60 THEN
    RAISE EXCEPTION 'post-apply: expected ~62 Panini sets in sets_summary, found %', v_panini;
  END IF;

  SELECT count(*) INTO v_diff FROM (
    (SELECT collection_id, set_slug, edition_count FROM public.sets_summary
      WHERE collection_id <> 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'
     EXCEPT SELECT * FROM _sets_summary_before)
    UNION ALL
    (SELECT * FROM _sets_summary_before
     EXCEPT SELECT collection_id, set_slug, edition_count FROM public.sets_summary
      WHERE collection_id <> 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b')
  ) d;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'post-apply: % non-Panini sets_summary rows changed', v_diff;
  END IF;

  IF has_table_privilege('anon', 'public.sets_summary', 'SELECT') THEN
    RAISE EXCEPTION 'post-apply: anon can read sets_summary';
  END IF;
END
$verify$;

DROP TABLE _sets_summary_before;
