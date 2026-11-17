-- audit_20261112_integrity_flags_candy_insert_and_reward_rarities_are_absent_at_source
--
-- edition_integrity_flags (v_rpc_trust_health arm, breach_at 250) read 2,660 at 7:50 AM PT 11-12. Of the
-- Candy canonical_missing_tier 988, 278 carried a Rarity label tier_type has no home for: Titan 200,
-- Unique 66, Rainbow 12 (5 on 11-11; the census minted more). Researched 2026-11-12 (Cowork cloud;
-- Trevor: "Can you try to figure those out using any online sources" → "Do what you think is best"):
--   * TITAN is a real tier — Candy's one "Special Edition" rarity, 200 burn-reward ICONs of the 2022
--     Leadoff Series, ranked above Epic (burn points Epic 40, TITAN 100; /43-100 vs Epic /250 and
--     Legendary 1/1 in that set). It is mapped to LEGENDARY in lib/chains/solana/normalize.ts and the
--     200 editions backfilled in the same change, so they leave this arm by HAVING a tier.
--   * UNIQUE and RAINBOW are not tiers: Unique is the label on inserts / variants / chasers (All-Star
--     Starter /40, Home Run Derby King /30, Rookie Legacy Card inserts /10, Showstopper variants /30,
--     Gems chaser plays /30); Rainbow is the label on Rainbow Collection chaser REWARDS ("Home Run
--     Rainbow Chaser", Base Series Rainbow Rewards /6-8), not the colour parallels (those are LEGENDARY
--     by name). normalize.ts's standing rule: an insert or quest reward has no tier — NULL, never a guess.
-- WHAT. tier_absent_at_source also accepts a key ending `:<slug>-unique` or `:<slug>-rainbow` (the rarity
-- segment editionKeyFromAsset appends). Still counted: a FABRICATED edition with such a key (no
-- thumbnail — 7 live), a Titan whose tier is still NULL (`-titan` → a defect, so a failed mapping shows),
-- any non-Candy edition. Columns and order unchanged; security_invoker=on re-set; 250 NOT raised.
-- Effect measured before apply: 71 editions move apart; with the Titan backfill the arm 2,660 -> ~2,389
-- (the rest is #246, still repointing).
--
-- PIN: supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql (re-pointed here).
-- REVERT: re-run the CREATE OR REPLACE VIEW from
--   supabase/migrations/20261112051013_audit_20261111_integrity_flags_one_of_one_keys_without_rarity_are_absent_at_source.sql


DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.v_edition_integrity_flags'::regclass)) <> 'ad72eb08a093ad724b556ba53eef4f3a' THEN
    RAISE EXCEPTION 'base moved: v_edition_integrity_flags is not the 20261112051013 definition read at 7:50 AM PT 11-12';
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
                      AND (right((e.external_id)::text, 12) ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'::text))
                  OR (right((e.external_id)::text, length(s.slug) + 8) = (':' || s.slug || '-unique'))
                  OR (right((e.external_id)::text, length(s.slug) + 9) = (':' || s.slug || '-rainbow')))) AS tier_absent_at_source
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
