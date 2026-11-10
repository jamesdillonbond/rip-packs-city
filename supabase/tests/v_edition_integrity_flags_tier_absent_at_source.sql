-- DB invariant: public.v_edition_integrity_flags — the tier arm (2026-11-09).
-- The property: a HYDRATED Candy edition (thumbnail present) whose prefixed key is exactly
-- `<prefix>:<slug(name)>` — nothing appended, i.e. the source asset had NO Rarity trait — is not a
-- missing-tier DEFECT; it is counted in canonical_tier_absent_at_source instead. Everything else with
-- a NULL tier stays in canonical_missing_tier: a FABRICATED edition (no thumbnail), an edition whose
-- key carries an unmapped rarity (`-titan`), and any non-Candy edition.
--
-- The view DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261110000502_audit_20261109_integrity_flags_tier_absent_at_source_is_counted_apart.sql);
-- __tests__/edition-integrity-flags-pin-matches-migration.test.ts fails CI if it drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (collection_id uuid, external_id varchar(100), name text, tier text, circulation_count int,
  thumbnail_url text, set_id_onchain text, play_id_onchain text);
INSERT INTO public.collections VALUES
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'candy_mlb'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day');

-- >>> BEGIN verbatim v_edition_integrity_flags (keep identical to the migration) >>>
CREATE OR REPLACE VIEW public.v_edition_integrity_flags WITH (security_invoker = on) AS
 WITH flagged AS (
         SELECT c.slug AS collection,
            ((e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid) AND ((e.external_id)::text !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text)) AS is_ts_dupe,
            e.circulation_count,
            e.tier,
            e.thumbnail_url,
            e.set_id_onchain,
            e.play_id_onchain,
            ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
             AND (e.thumbnail_url IS NOT NULL)
             AND (e.tier IS NULL)
             AND (position(':' in (e.external_id)::text) > 0)
             AND (s.slug <> '')
             AND (right((e.external_id)::text, length(s.slug) + 1) = (':' || s.slug))) AS tier_absent_at_source
           FROM ((editions e
             JOIN collections c ON ((c.id = e.collection_id)))
             CROSS JOIN LATERAL ( SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(COALESCE(e.name, ''::text)), '\s+'::text, '-'::text, 'g'::text), '[^a-z0-9:_-]'::text, ''::text, 'g'::text), '-+'::text, '-'::text, 'g'::text), '^-+|-+$'::text, ''::text, 'g'::text) AS slug) s)
        )
 SELECT collection,
    count(*) AS total_editions,
    count(*) FILTER (WHERE is_ts_dupe) AS ts_uuid_dupe_editions,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND ((circulation_count IS NULL) OR (circulation_count = 0)))) AS canonical_bad_circulation,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND (tier IS NULL) AND (NOT tier_absent_at_source))) AS canonical_missing_tier,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND (thumbnail_url IS NULL))) AS canonical_missing_thumbnail,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND ((set_id_onchain IS NULL) OR (play_id_onchain IS NULL)))) AS canonical_missing_onchain_ids,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND tier_absent_at_source)) AS canonical_tier_absent_at_source
   FROM flagged
  GROUP BY collection
  ORDER BY collection;
-- <<< END verbatim v_edition_integrity_flags <<<

INSERT INTO public.editions VALUES
  -- hydrated, no Rarity in source: key = prefix:slug(name) → NOT a defect, counted apart
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-all-star-tricons:2022-tricon-mantiply-musgrove', '2022 Tricon Mantiply Musgrove', NULL, 1, 'https://arweave.net/a', NULL, NULL),
  -- hydrated, accents and punctuation in the name slug the same way the normalizer does
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-all-star-tricons:2022-tricon-arraez-lpez', '2022 Tricon Arraez López!', NULL, 1, 'https://arweave.net/b', NULL, NULL),
  -- hydrated, UNMAPPED rarity suffix → still a defect (a product decision, not an absence)
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2023-titans:aaron-judge-titan', 'Aaron Judge', NULL, 10, 'https://arweave.net/c', NULL, NULL),
  -- FABRICATED (no thumbnail) with the same key shape → still a defect
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:phil-bickford', 'Phil Bickford', NULL, NULL, NULL, NULL, NULL),
  -- tier present → neither
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:phil-bickford-core', 'Phil Bickford', 'COMMON', 850, 'https://arweave.net/d', NULL, NULL),
  -- non-Candy edition with a NULL tier and a matching-looking key → still a defect
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'x:patrick-mahomes', 'Patrick Mahomes', NULL, 5, 'https://x/y', '1', '2');

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v_edition_integrity_flags WHERE collection = 'candy_mlb';
  PERFORM _assert_eq(r.canonical_tier_absent_at_source::text, '2', 'two hydrated editions whose source had no Rarity are counted apart');
  PERFORM _assert_eq(r.canonical_missing_tier::text, '2', '⚠ the unmapped-rarity and the FABRICATED edition stay defects');
  PERFORM _assert_eq(r.canonical_missing_thumbnail::text, '1', 'the fabricated edition is still a missing thumbnail');
  PERFORM _assert_eq(r.canonical_bad_circulation::text, '1', 'and still a bad circulation');
  SELECT * INTO r FROM public.v_edition_integrity_flags WHERE collection = 'nfl_all_day';
  PERFORM _assert_eq(r.canonical_missing_tier::text, '1', 'a non-Candy NULL tier is always a defect');
  PERFORM _assert_eq(r.canonical_tier_absent_at_source::text, '0', 'and never counted apart');
END $$;

ROLLBACK;
