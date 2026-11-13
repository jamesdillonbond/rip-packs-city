-- DB invariant: public.v_edition_integrity_flags — the tier arm (2026-11-09).
-- The property: a HYDRATED Candy edition (thumbnail present) whose prefixed key is exactly
-- `<prefix>:<slug(name)>` — nothing appended, i.e. the source asset had NO Rarity trait — is not a
-- missing-tier DEFECT; it is counted in canonical_tier_absent_at_source instead. Everything else with
-- a NULL tier stays in canonical_missing_tier: a FABRICATED edition (no thumbnail), an edition whose
-- key carries an unmapped rarity (`-titan`), and any non-Candy edition.
--
-- The view DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261112154918_audit_20261112_integrity_flags_candy_insert_and_reward_rarities_are_absent_at_source.sql;
-- 2026-11-11: a 1-of-1 key `:<slug>-<12 base58>` with no rarity segment is absent-at-source too;
-- 2026-11-12: a `-unique` / `-rainbow` segment (Candy insert / reward labels, not tiers) is too);
-- __tests__/edition-integrity-flags-pin-matches-migration.test.ts fails CI if it drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.ufc_chain_set_editions (edition_id uuid, set_id int);
CREATE TABLE public.ufc_chain_set_metadata (set_id int, tier text);
CREATE TABLE public.editions (id uuid DEFAULT gen_random_uuid(), collection_id uuid, external_id varchar(100), name text, tier text, circulation_count int,
  thumbnail_url text, set_id_onchain text, play_id_onchain text, rarity_label text);
INSERT INTO public.collections VALUES
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'candy_mlb'),
  ('9b4824a8-736d-4a96-b450-8dcc0c46b023', 'ufc_strike'),
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
            e.rarity_label,
            ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
             AND (e.thumbnail_url IS NOT NULL)
             AND (e.circulation_count IS NULL)) AS circulation_absent_at_source,
            (((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
             AND (e.thumbnail_url IS NOT NULL)
             AND (e.tier IS NULL)
             AND (position(':' in (e.external_id)::text) > 0)
             AND (s.slug <> '')
             AND ((right((e.external_id)::text, length(s.slug) + 1) = (':' || s.slug))
                  OR ((right((e.external_id)::text, length(s.slug) + 14) = (':' || s.slug || '-' || right((e.external_id)::text, 12)))
                      AND (right((e.external_id)::text, 12) ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'::text))
                  OR (right((e.external_id)::text, length(s.slug) + 8) = (':' || s.slug || '-unique'))
                  OR (right((e.external_id)::text, length(s.slug) + 9) = (':' || s.slug || '-rainbow'))
                  OR ((e.rarity_label IS NOT NULL)
                      AND (lower(e.rarity_label) <> ALL (ARRAY['core'::text, 'common'::text, 'uncommon'::text, 'rare'::text, 'epic'::text, 'titan'::text, 'legendary'::text])))))
             OR ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
                 AND (e.thumbnail_url IS NOT NULL)
                 AND (e.tier IS NULL)
                 AND ((e.external_id)::text !~ '-(core|common|uncommon|rare|epic|titan|legendary)(-[1-9A-HJ-NP-Za-km-z]{12})?$'::text))
             OR ((e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid)
                 AND (e.tier IS NULL)
                 AND (EXISTS ( SELECT 1
                        FROM (ufc_chain_set_editions ce
                          JOIN ufc_chain_set_metadata cm ON ((cm.set_id = ce.set_id)))
                       WHERE ((ce.edition_id = e.id) AND (cm.tier IS NULL)))))) AS tier_absent_at_source
           FROM ((editions e
             JOIN collections c ON ((c.id = e.collection_id)))
             CROSS JOIN LATERAL ( SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(COALESCE(e.name, ''::text)), '\s+'::text, '-'::text, 'g'::text), '[^a-z0-9:_-]'::text, ''::text, 'g'::text), '-+'::text, '-'::text, 'g'::text), '^-+|-+$'::text, ''::text, 'g'::text) AS slug) s)
        )
 SELECT collection,
    count(*) AS total_editions,
    count(*) FILTER (WHERE is_ts_dupe) AS ts_uuid_dupe_editions,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND ((circulation_count IS NULL) OR (circulation_count = 0)) AND (NOT circulation_absent_at_source))) AS canonical_bad_circulation,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND (tier IS NULL) AND (NOT tier_absent_at_source))) AS canonical_missing_tier,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND (thumbnail_url IS NULL))) AS canonical_missing_thumbnail,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND ((set_id_onchain IS NULL) OR (play_id_onchain IS NULL)))) AS canonical_missing_onchain_ids,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND tier_absent_at_source)) AS canonical_tier_absent_at_source,
    count(*) FILTER (WHERE ((NOT is_ts_dupe) AND circulation_absent_at_source)) AS canonical_circulation_absent_at_source
   FROM flagged
  GROUP BY collection
  ORDER BY collection;
-- <<< END verbatim v_edition_integrity_flags <<<

INSERT INTO public.editions (collection_id, external_id, name, tier, circulation_count, thumbnail_url, set_id_onchain, play_id_onchain) VALUES
  -- hydrated, no Rarity in source: key = prefix:slug(name) → NOT a defect, counted apart
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-all-star-tricons:2022-tricon-mantiply-musgrove', '2022 Tricon Mantiply Musgrove', NULL, 1, 'https://arweave.net/a', NULL, NULL),
  -- hydrated, accents and punctuation in the name slug the same way the normalizer does
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-all-star-tricons:2022-tricon-arraez-lpez', '2022 Tricon Arraez López!', NULL, 1, 'https://arweave.net/b', NULL, NULL),
  -- 2026-11-11: hydrated 1-of-1, NO rarity segment, asset-id suffix → absent at source
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-all-star-tricons:2022-tricon-anderson-castillo-5GkjPgEJRwjS', '2022 Tricon Anderson Castillo', NULL, 1, 'https://arweave.net/e', NULL, NULL),
  -- 2026-11-11: hydrated 1-of-1 WITH an unmapped rarity segment → still a defect
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2023-titans:mike-trout-titan-AWN51rGSk3t2', 'Mike Trout', NULL, 1, 'https://arweave.net/f', NULL, NULL),
  -- 2026-11-11: hydrated, ordinary rarity suffix of 12 chars containing '-' never reads as an asset id
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:mookie-betts-uncommon', 'Mookie Betts', NULL, 125, 'https://arweave.net/g', NULL, NULL),
  -- hydrated, UNMAPPED rarity suffix → still a defect (a product decision, not an absence)
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2023-titans:aaron-judge-titan', 'Aaron Judge', NULL, 10, 'https://arweave.net/c', NULL, NULL),
  -- FABRICATED (no thumbnail) with the same key shape → still a defect
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:phil-bickford', 'Phil Bickford', NULL, NULL, NULL, NULL, NULL),
  -- tier present → neither
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:phil-bickford-core', 'Phil Bickford', 'COMMON', 850, 'https://arweave.net/d', NULL, NULL),
  -- 2026-11-12: Candy insert / reward rarity labels are not tiers → absent at source
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2025-all-star-icons:shohei-ohtani-allstar-starter-unique', 'Shohei Ohtani AllStar Starter', NULL, 40, 'https://arweave.net/h', NULL, NULL),
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:base-series-rainbow-rewards:mike-trout-rainbow', 'Mike Trout', NULL, 7, 'https://arweave.net/i', NULL, NULL),
  -- 2026-11-12: the same label on a FABRICATED edition (no thumbnail) → still a defect
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2025-mlb-gems-june:mike-trout-home-run-rainbow-c-rainbow', 'Mike Trout Home Run Rainbow C', NULL, NULL, NULL, NULL, NULL),
  -- 2026-11-12: hydrated, NO "/N" at source (sealed inventory / open edition) → edition size absent at source
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:sealed-item', 'Sealed Item', NULL, NULL, 'https://arweave.net/l', NULL, NULL),
  -- non-Candy edition with a NULL tier and a matching-looking key → still a defect
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'x:patrick-mahomes', 'Patrick Mahomes', NULL, 5, 'https://x/y', '1', '2');

INSERT INTO public.editions (collection_id, external_id, name, tier, circulation_count, thumbnail_url, set_id_onchain, play_id_onchain) VALUES
  -- 2026-11-13: hydrated, untiered, key length-fitted with a hash (slug test cannot match) → absent at source
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-moment-boxes:rookie-performance:-george-kirby-julio-rodriguez-spen-36b5cfa5', 'Rookie Performance: George Kirby, Julio Rodriguez, Spencer Strider', NULL, 152, 'https://arweave.net/n', NULL, NULL),
  -- ⚠ hydrated, untiered, key ENDS in a mapped rarity (a failed mapping) → still a defect
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2023-base:shohei-ohtani-player-of-the-month-rare', 'Shohei Ohtani Player of the Month', NULL, 50, 'https://arweave.net/o', NULL, NULL);

INSERT INTO public.editions (collection_id, external_id, name, tier, circulation_count, thumbnail_url, set_id_onchain, play_id_onchain, rarity_label) VALUES
  -- 2026-11-12 (native rarity_label): a label with NO tier_type equivalent → absent at source
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-all-star-tricons:2022-tricon-judge-soto-gold', '2022 Tricon Judge Soto', NULL, 1, 'https://arweave.net/j', NULL, NULL, 'Gold'),
  -- ⚠ a Titan label with a NULL tier stays a defect (the mapping failed) — the label never hides it
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:giancarlo-stanton-titan', 'Giancarlo Stanton', NULL, 77, 'https://arweave.net/k', NULL, NULL, 'Titan'),
  -- ⚠ circulation 0 on a hydrated edition is still a defect (0 is a written value, not an absence)
  ('209ade70-32c5-4470-bc7c-4793d660f713', 'c:2022-leadoff-icons:pete-alonso-core', 'Pete Alonso', 'COMMON', 0, 'https://arweave.net/m', NULL, NULL, 'Core'),
  -- non-Candy edition with a NULL circulation and a thumbnail → still a defect (never absent)
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'x:travis-kelce', 'Travis Kelce', 'COMMON', NULL, 'https://x/z', '1', '3', 'Gold');

-- 2026-11-12: UFC catchphrase editions — chain set carries no TIER → absent at source; a chain set WITH a
-- tier, or an unmapped edition, stays a defect.
INSERT INTO public.editions (id, collection_id, external_id, name, tier, circulation_count, thumbnail_url, set_id_onchain, play_id_onchain) VALUES
  ('00000000-0000-0000-0000-000000000001', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 'SHUT-UP-20830', 'Shut Up', NULL, 20830, 'https://ipfs.io/a', '1', '1'),
  ('00000000-0000-0000-0000-000000000002', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 'X-UFC-1-KO-99', 'X', NULL, 99, 'https://ipfs.io/b', '1', '2'),
  ('00000000-0000-0000-0000-000000000003', '9b4824a8-736d-4a96-b450-8dcc0c46b023', 'Y-UNMAPPED-10', 'Y', NULL, 10, 'https://ipfs.io/c', '1', '3');
INSERT INTO public.ufc_chain_set_editions VALUES ('00000000-0000-0000-0000-000000000001', 1), ('00000000-0000-0000-0000-000000000002', 2);
INSERT INTO public.ufc_chain_set_metadata VALUES (1, NULL), (2, 'Champion');

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v_edition_integrity_flags WHERE collection = 'ufc_strike';
  PERFORM _assert_eq(r.canonical_tier_absent_at_source::text, '1', 'a UFC edition whose chain set carries no TIER is absent at source');
  PERFORM _assert_eq(r.canonical_missing_tier::text, '2', '⚠ a NULL tier whose chain set HAS a tier, and an unmapped one, stay defects');
  SELECT * INTO r FROM public.v_edition_integrity_flags WHERE collection = 'candy_mlb';
  PERFORM _assert_eq(r.canonical_tier_absent_at_source::text, '8', 'eight hydrated editions with no tier at source are counted apart (incl. the 1-of-1 asset-id key, the -unique / -rainbow labels, a native Gold label, the sealed item, and the hash-fitted key)');
  PERFORM _assert_eq(r.canonical_missing_tier::text, '7', '⚠ NULL-tier editions whose key ends in a MAPPED rarity (-titan ×3 incl. one with a Titan rarity_label, -rare), the rarity-but-NULL-tier edition and both FABRICATED editions stay defects');
  PERFORM _assert_eq(r.canonical_missing_thumbnail::text, '2', 'the fabricated editions are still missing thumbnails');
  PERFORM _assert_eq(r.canonical_bad_circulation::text, '3', 'both fabricated editions (NULL, no thumbnail) and the hydrated circulation 0 are bad circulations');
  PERFORM _assert_eq(r.canonical_circulation_absent_at_source::text, '1', 'the hydrated sealed item with no "/N" is counted apart');
  SELECT * INTO r FROM public.v_edition_integrity_flags WHERE collection = 'nfl_all_day';
  PERFORM _assert_eq(r.canonical_missing_tier::text, '1', 'a non-Candy NULL tier is always a defect');
  PERFORM _assert_eq(r.canonical_tier_absent_at_source::text, '0', 'and never counted apart (a native label outside Candy changes nothing)');
  PERFORM _assert_eq(r.canonical_bad_circulation::text, '1', 'a non-Candy NULL circulation is always a defect');
  PERFORM _assert_eq(r.canonical_circulation_absent_at_source::text, '0', 'and never counted apart');
END $$;

ROLLBACK;
