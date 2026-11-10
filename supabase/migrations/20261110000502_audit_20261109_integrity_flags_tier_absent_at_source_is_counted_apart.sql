-- audit_20261109_integrity_flags_tier_absent_at_source_is_counted_apart
--
-- edition_integrity_flags (v_rpc_trust_health arm, breach_at 250) read ~20,633 on 11-09, Candy 20,607.
-- Re-derived 2026-11-09 ~4:10 PM PT (Claude Code cloud; Trevor: "Do everything, leave nothing
-- unresolved from this thread"):
--   * 4,844 Candy editions are FABRICATED (built from an asset name alone: tier, player and thumbnail
--     all NULL). They stay COUNTED — the morning session's hydration/repoint is draining them, and
--     the gate must keep seeing them ("Do NOT exclude these from the gate").
--   * 5,507 Candy editions are hydrated (thumbnail present) and carry NO TIER BECAUSE THE SOURCE HAS
--     NO RARITY TRAIT. Proof is in the key: lib/chains/solana/normalize.ts editionKeyFromAsset builds a
--     prefixed key as `<prefix>:<slug(name)>` and appends `-<rarity>` only when the asset HAS a Rarity
--     attribute. For these 5,507 the key is exactly `<prefix>:<slug(name)>` — nothing appended. The
--     normalizer leaves tier NULL there by design ("NULL, never a guess"); counting them as a defect
--     made the arm permanently red on a fact no fix can change.
--   * 272 more carry a Rarity value the tier map does not know (Titan 200, Unique 66, Rainbow 5, 1
--     other). Those STAY counted: mapping them is a product decision, not a structural absence.
--
-- WHAT. canonical_missing_tier no longer counts a hydrated edition whose prefixed key proves there was
-- no Rarity trait; the excluded population is published in a NEW last column,
-- canonical_tier_absent_at_source, so it is visible, not hidden. Every other column, and the column
-- order, is unchanged (v_rpc_trust_health sums the first three canonical_* columns by name).
-- security_invoker=on is re-set explicitly (CREATE OR REPLACE VIEW resets reloptions).
-- The 250 threshold is NOT raised.
--
-- PIN: supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql
-- REVERT: CREATE OR REPLACE the view with canonical_missing_tier's FILTER back to
--   ((NOT is_ts_dupe) AND (tier IS NULL)), keeping security_invoker = on. The new last column can stay
--   (CREATE OR REPLACE VIEW cannot drop a column; v_rpc_trust_health does not read it).


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
