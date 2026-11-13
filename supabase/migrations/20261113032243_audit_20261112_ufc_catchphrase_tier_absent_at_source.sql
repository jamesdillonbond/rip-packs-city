-- audit_20261112_ufc_catchphrase_tier_absent_at_source
--
-- 2026-11-12 ~7:50 PM PT (Claude Code cloud; Trevor: "Work through and get those figured out").
-- The 14 UFC Strike editions with a NULL tier in edition_integrity_flags are the catchphrase moments ("The Last
-- Stylebender", "Shut Up", "My Balls Was Hot" …) whose ON-CHAIN set carries no TIER trait: 20261018170101 set
-- their tier NULL on purpose ("NULL (unknown) where the chain set carries no TIER") instead of the old
-- fabricated CONTENDER/CHALLENGER. Re-derived: 14 of 14 NULL-tier UFC editions map to a ufc_chain_set_metadata
-- row with tier NULL; 0 unmapped. That is tier ABSENT AT SOURCE — counted apart like Candy's, never invented.
-- A UFC edition with a NULL tier that is unmapped, or whose chain set HAS a tier, stays a defect.
-- Columns unchanged; security_invoker=on re-set; breach_at 250 NOT raised.
--
-- PIN: supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql (re-pointed here).
-- REVERT: re-run the CREATE OR REPLACE VIEW from
--   supabase/migrations/20261112161513_audit_20261112_candy_native_rarity_label_and_open_editions_absent_at_source.sql

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.v_edition_integrity_flags'::regclass)) <> 'deed0fbac47956584142857fd786ba46' THEN
    RAISE EXCEPTION 'base moved: v_edition_integrity_flags is not the 20261112161513 definition read at 7:50 PM PT 11-12';
  END IF;
END
$guard$;

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

DO $post$
DECLARE n bigint;
BEGIN
  SELECT canonical_missing_tier INTO n FROM public.v_edition_integrity_flags WHERE collection = 'ufc_strike';
  IF n <> 0 THEN RAISE EXCEPTION 'expected 0 UFC missing-tier after the catchphrase rule, got %', n; END IF;
END
$post$;
