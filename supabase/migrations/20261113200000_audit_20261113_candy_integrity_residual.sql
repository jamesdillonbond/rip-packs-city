-- audit_20261113_candy_integrity_residual
--
-- 2026-11-13 ~7:35 AM PT (Claude Code cloud; Trevor: "Work through the stuff still open and figure it out").
-- edition_integrity_flags 34 = Candy 26 + Top Shot 8 (Dapper art, no source). The Candy 26, re-derived live:
--
-- (1) 6 MISSING TIER that are not defects. Hydrated editions (thumbnail, holders, edition size) whose keys the
--     view's "key = prefix:slug(name)" test cannot match — length-fitted with an 8-hex hash (`…-36b5cfa5`) or
--     carrying extra text (`…-donation100000`). The writer sets `tier` from the Rarity trait at insert
--     (candyTierFromAsset), so a HYDRATED Candy edition with tier NULL has no mapped rarity at source. New view
--     branch: Candy + thumbnail + tier NULL + key NOT ending in a mapped rarity segment → tier absent at source.
--     A key ending -core/-uncommon/-rare/-epic/-titan/-legendary with a NULL tier stays a defect (a failed
--     mapping — the 20261112154918 failsafe). Fabricated name-only editions (no thumbnail) never qualify.
-- (2) 11 WRONG rarity_label from MY 20261112161513 backfill: the "rarity" word was part of the card's NAME
--     ("2025 MLB Tokyo Series Rainbow", "2021 World Series Gold", "For Fandom", "… of Rare"). Their key is
--     exactly prefix:slug(name) — no rarity segment was ever appended, so the source had no Rarity trait.
--     Cleared to NULL (the edition page's native-rarity chip would have shown "Rare"/"Gold" wrongly).
-- (3) 7 UNHELD label-less editions the :37 orphan cleanup cannot retire: 5 named by candy_edition_market_daily
--     rows WITH data (snapshots taken while listings sat on the fake key; those listings were re-pointed
--     11-12), 1 by an inactive offer whose token has no holdings row (a pack/burnt asset — never a card),
--     1 ("2022 MLB ICON All-Star Series - Blue Edition") a name-only edition carrying tier LEGENDARY from the
--     colour in its name, which the cleanup's `tier IS NULL` rule skips. Backed up, then: market rows with data
--     deleted, the offer un-attached (edition_id NULL — the column is nullable; the offer row stays), the Blue
--     Edition row deleted. The :37 cleanup removes the other 6 editions (and their empty snapshots).
-- Expected: edition_integrity_flags 34 → 8 (Top Shot only). Columns unchanged; security_invoker=on; 250 not raised.
--
-- BACKUP: public.audit_20261113_candy_integrity_residual_backup (tbl, row jsonb).
-- PIN: supabase/tests/v_edition_integrity_flags_tier_absent_at_source.sql (re-pointed here).
-- REVERT: re-run the view from 20261113032243_audit_20261112_ufc_catchphrase_tier_absent_at_source.sql; restore
--   rarity_label / market rows / offer edition_id / the edition row from the backup table.

CREATE TABLE IF NOT EXISTS public.audit_20261113_candy_integrity_residual_backup (tbl text, row jsonb, saved_at timestamptz DEFAULT now());
ALTER TABLE public.audit_20261113_candy_integrity_residual_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261113_candy_integrity_residual_backup FROM PUBLIC, anon, authenticated;

DO $guard$
BEGIN
  IF md5(pg_get_viewdef('public.v_edition_integrity_flags'::regclass)) <> 'de740c0f87187154b9404f423f46fe6b' THEN
    RAISE EXCEPTION 'base moved: v_edition_integrity_flags is not the 20261113032243 definition read at 7:35 AM PT 11-13';
  END IF;
END
$guard$;

DO $data$
DECLARE c_candy constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713'; n int;
BEGIN
  -- (2) rarity_label read from the NAME by the backfill
  CREATE TEMP TABLE _lbl ON COMMIT DROP AS
  SELECT e.id, e.external_id, e.rarity_label FROM public.editions e
   CROSS JOIN LATERAL (SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(e.name,'')), '\s+','-','g'), '[^a-z0-9:_-]','','g'), '-+','-','g'), '^-+|-+$','','g') AS slug) s
   WHERE e.collection_id = c_candy AND e.rarity_label IS NOT NULL AND s.slug <> ''
     AND right(e.external_id::text, length(s.slug) + 1) = ':' || s.slug;
  SELECT count(*) INTO n FROM _lbl;
  IF n <> 11 THEN RAISE EXCEPTION 'expected 11 name-derived rarity_labels, found %', n; END IF;
  INSERT INTO public.audit_20261113_candy_integrity_residual_backup (tbl, row) SELECT 'editions.rarity_label', to_jsonb(l) FROM _lbl l;
  UPDATE public.editions e SET rarity_label = NULL FROM _lbl l WHERE e.id = l.id;

  -- (3) the unheld label-less editions
  CREATE TEMP TABLE _unheld ON COMMIT DROP AS
  SELECT u.id, u.external_id, u.tier FROM public.editions u
   WHERE u.collection_id = c_candy AND u.thumbnail_url IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w WHERE w.collection_id = u.collection_id AND w.edition_key = u.external_id);
  SELECT count(*) INTO n FROM _unheld;
  IF n > 10 THEN RAISE EXCEPTION 'expected ~7 unheld label-less editions, found %', n; END IF;

  INSERT INTO public.audit_20261113_candy_integrity_residual_backup (tbl, row)
  SELECT 'candy_edition_market_daily', to_jsonb(d) FROM public.candy_edition_market_daily d JOIN _unheld u ON u.id = d.edition_id
   WHERE d.floor_ask_usd IS NOT NULL OR coalesce(d.listed_count, 0) > 0 OR d.best_offer_usd IS NOT NULL OR coalesce(d.offer_count, 0) > 0;
  DELETE FROM public.candy_edition_market_daily d USING _unheld u
   WHERE u.id = d.edition_id
     AND (d.floor_ask_usd IS NOT NULL OR coalesce(d.listed_count, 0) > 0 OR d.best_offer_usd IS NOT NULL OR coalesce(d.offer_count, 0) > 0);

  INSERT INTO public.audit_20261113_candy_integrity_residual_backup (tbl, row)
  SELECT 'candy_offers', to_jsonb(o) FROM public.candy_offers o JOIN _unheld u ON u.id = o.edition_id
   WHERE NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w WHERE w.collection_id = c_candy AND w.moment_id = o.token_mint);
  UPDATE public.candy_offers o SET edition_id = NULL FROM _unheld u
   WHERE u.id = o.edition_id
     AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w WHERE w.collection_id = c_candy AND w.moment_id = o.token_mint);

  -- the name-only edition the cleanup skips for carrying a tier (unheld, unreferenced)
  INSERT INTO public.audit_20261113_candy_integrity_residual_backup (tbl, row)
  SELECT 'editions', to_jsonb(e) FROM public.editions e JOIN _unheld u ON u.id = e.id WHERE u.tier IS NOT NULL;
  DELETE FROM public.candy_edition_market_daily d USING _unheld u WHERE u.id = d.edition_id AND u.tier IS NOT NULL;
  DELETE FROM public.editions e USING _unheld u WHERE e.id = u.id AND u.tier IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 1 THEN RAISE EXCEPTION 'expected to delete at most 1 tiered name-only edition, deleted %', n; END IF;
END
$data$;

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

DO $post$
DECLARE n bigint;
BEGIN
  SELECT canonical_missing_tier INTO n FROM public.v_edition_integrity_flags WHERE collection = 'candy_mlb';
  IF n > 6 THEN RAISE EXCEPTION 'expected Candy missing-tier to fall to the unheld editions only (<= 6), got %', n; END IF;
END
$post$;
