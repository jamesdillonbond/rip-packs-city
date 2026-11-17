-- audit_20261112_candy_native_rarity_label_and_open_editions_absent_at_source
--
-- 2026-11-12 ~8:10 AM PT (Claude Code cloud; Trevor: "Keep going and try to fix all of these" and, on the
-- Candy rarities: "Map it out the way the asset class works for this collection itself. We don't need to
-- try to fit these into boxes that don't make sense for this collectible").
--
-- (1) NATIVE RARITY. editions.rarity_label = the collection's OWN rarity name, from the source title-cased
--     (Candy: the `Rarity` trait — Core, Uncommon, Rare, Epic, Titan, Legendary, Unique, Rainbow, Gold,
--     Silver, Fandom …), beside the shared tier_type, which stays the cross-collection ladder. Same column
--     name Panini's tables already use for the same idea. Written by normalizeEdition (only when the trait
--     is present — a missing trait never clobbers a stored label); BACKFILLED here from the rarity segment
--     editionKeyFromAsset appended to every prefixed Candy key (`…:<slug>-<rarity>[-<12-char asset id>]`).
--     A native label with no tier_type equivalent (Gold, Silver, Fandom, …) is counted with
--     tier_absent_at_source — the source HAS a rarity, it is just not on the shared ladder. Titan stays a
--     defect when its tier is NULL (the 20261112154918 failsafe), as does any core..legendary label.
-- (2) EDITION SIZE ABSENT AT SOURCE. 268 hydrated Candy editions (thumbnail present) have circulation NULL
--     (never 0): editionSizeFromAsset reads the "/N" of the Serial Number trait and these carry none —
--     Candy's unrevealed "Sealed Item" inventory (218 editions, 107k assets, all in the house inventory
--     wallet 6uKec…), open-edition Team Balls (`TBD/171`), Justice League membership cards, Merge Fuel,
--     Spark Cards, tickets. Counted apart in canonical_circulation_absent_at_source, as the tier rule does.
--     Still a defect: circulation 0, and a NULL with no thumbnail (the #246 label-less editions — NOT
--     excluded, per known-issues #246).
-- Columns: existing ones unchanged in name and order; canonical_circulation_absent_at_source appended.
-- security_invoker=on re-set; breach_at 250 NOT raised.
--
-- PIN: supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql (re-pointed here).
-- REVERT: re-run the CREATE OR REPLACE VIEW from
--   supabase/migrations/20261112154918_audit_20261112_integrity_flags_candy_insert_and_reward_rarities_are_absent_at_source.sql
--   (a view cannot DROP an appended column via REPLACE: DROP VIEW … CASCADE is NOT safe — v_rpc_trust_health
--   depends on it; leave the column, it is additive) and ALTER TABLE public.editions DROP COLUMN rarity_label
--   only after reverting the view.

ALTER TABLE public.editions ADD COLUMN IF NOT EXISTS rarity_label text;
COMMENT ON COLUMN public.editions.rarity_label IS
  'The collection''s OWN rarity name from source, title-cased (Candy: the Rarity trait, candyRarityLabel). tier is the shared cross-collection ladder; this is the native one. NULL = the source carries none, or not yet captured.';

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.v_edition_integrity_flags'::regclass)) <> 'b148926e8bdffb3b9438ba46c2ba9571' THEN
    RAISE EXCEPTION 'base moved: v_edition_integrity_flags is not the 20261112154918 definition read at 8:05 AM PT 11-12';
  END IF;
END
$guard$;

-- Backfill Candy's native label from the key's rarity segment (prefixed sets only: Base keys carry none).
UPDATE public.editions e
   SET rarity_label = initcap(m[1])
  FROM (SELECT id, regexp_match(external_id, ':[^:]*-(core|common|uncommon|rare|epic|titan|legendary|unique|rainbow|gold|silver|fandom)(?:-[1-9A-HJ-NP-Za-km-z]{12})?$') AS m
          FROM public.editions WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713') k
 WHERE e.id = k.id AND k.m IS NOT NULL AND e.rarity_label IS NULL;

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
            ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
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
                      AND (lower(e.rarity_label) <> ALL (ARRAY['core'::text, 'common'::text, 'uncommon'::text, 'rare'::text, 'epic'::text, 'titan'::text, 'legendary'::text]))))) AS tier_absent_at_source
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
DECLARE n_label bigint; n_titan bigint; n_circ bigint;
BEGIN
  SELECT count(*) INTO n_label FROM public.editions WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' AND rarity_label IS NOT NULL;
  SELECT count(*) INTO n_titan FROM public.editions WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713' AND rarity_label = 'Titan';
  SELECT canonical_circulation_absent_at_source INTO n_circ FROM public.v_edition_integrity_flags WHERE collection = 'candy_mlb';
  IF n_label < 15000 OR n_titan <> 200 THEN
    RAISE EXCEPTION 'backfill off: % labelled, % Titan (want >=15000 and 200)', n_label, n_titan;
  END IF;
  IF n_circ < 200 THEN
    RAISE EXCEPTION 'circulation-absent rule matched only %', n_circ;
  END IF;
END
$post$;
