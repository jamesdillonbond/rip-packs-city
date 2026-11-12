-- audit_20261111_integrity_flags_one_of_one_keys_without_rarity_are_absent_at_source
--
-- edition_integrity_flags (v_rpc_trust_health arm, breach_at 250) read 6,793 at 9:05 PM PT 11-11, Candy
-- 6,771. Re-derived 2026-11-11 ~9:30 PM PT (Claude Code cloud; Trevor: "Keep going"):
--   * 20261110000502 counts a hydrated Candy edition apart (canonical_tier_absent_at_source) when its
--     prefixed key is exactly `<prefix>:<slug(name)>`: editionKeyFromAsset appends `-<rarity>` only when
--     the asset HAS a Rarity trait, so a bare key proves the source carried none.
--   * The same day (chain-strategy.md, 11-09) a 1-of-1 card started keying as
--     `<prefix>:<slug>[-<rarity>]-<first 12 chars of its asset id>`. A 1/1 WITHOUT a Rarity trait now
--     ends `:<slug>-<12 base58 chars>`, which the bare-key test cannot see, so 4,133 such editions
--     (2022 All-Star Tricons, 1-of-1 Player Highlights, The Bat Cowl …) were counted as missing-tier
--     defects — and the census mints more as it walks (newest created 11-11), so the arm was RISING
--     while #246 drained. No fix can give them a tier the source does not have.
--   * Evidence the key shape is the right signal and not a proxy: 73 of the collections holding these
--     have ZERO tiered editions (5,710 editions); in the 26 mixed collections the tiered cards carry a
--     `-<rarity>` segment and these do not.
-- WHAT. tier_absent_at_source also accepts `:<slug>-<12 base58 chars>` (the 1/1 suffix, which cannot
-- contain '-'). A 1/1 WITH a rarity segment (`…-titan-<asset>`) does not match and stays a defect, as do
-- the FABRICATED name-only editions (#246: no thumbnail, so the predicate never applies) and the
-- unmapped rarities (Titan 200, Unique 66, Rainbow 5 — a product decision, unchanged). Columns and
-- order unchanged; security_invoker=on re-set; the 250 threshold is NOT raised.
-- Effect measured before apply: canonical_missing_tier 5,121 -> ~988; arm 6,793 -> ~2,660 (the rest is
-- the #246 repair plus the 266 Titan/Unique and 19 inserts).
--
-- PIN: supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql (re-pointed here).
-- REVERT: re-run the CREATE OR REPLACE VIEW from
--   supabase/migrations/20261110000502_audit_20261109_integrity_flags_tier_absent_at_source_is_counted_apart.sql


DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.v_edition_integrity_flags'::regclass)) <> 'dedcc6db48e34a93d560a2f23036d7a7' THEN
    RAISE EXCEPTION 'base moved: v_edition_integrity_flags is not the 20261110000502 definition read at 9:20 PM PT';
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
            ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
             AND (e.thumbnail_url IS NOT NULL)
             AND (e.tier IS NULL)
             AND (position(':' in (e.external_id)::text) > 0)
             AND (s.slug <> '')
             AND ((right((e.external_id)::text, length(s.slug) + 1) = (':' || s.slug))
                  OR ((right((e.external_id)::text, length(s.slug) + 14) = (':' || s.slug || '-' || right((e.external_id)::text, 12)))
                      AND (right((e.external_id)::text, 12) ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'::text)))) AS tier_absent_at_source
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
