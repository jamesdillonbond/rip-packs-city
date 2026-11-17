-- audit_20260904_sixteen_ultimate_one_of_one_editions_atlas_has_and_we_never_had_five_of_them_in_user_collections
--
-- anon-exec: creates no function. It inserts 16 rows into public.editions and one
-- audit table. No ACL anywhere is touched.
--
-- WHAT THIS IS. Measuring the "new-edition creation" gap left open by the
-- catalog-walker retirement turned it from a vague backlog into a live defect.
-- Atlas knows 13,921 Top Shot editions; `editions` carries 13,436. Of the 579
-- Atlas rows we lack, 563 are parallels -- and 16 are BASE rows. Every one of
-- those 16 is `tier = ULTIMATE, circulation_count = 1`: a one-of-one trophy
-- Moment, the most valuable class on the platform.
--
-- 🚨 FIVE OF THEM ARE IN USER COLLECTIONS RIGHT NOW, and they render blank.
-- `wallet_moments_cache` denormalises its display fields FROM `editions`, so with
-- no edition row those rows carry NULL player_name, NULL set_name, NULL tier,
-- NULL image_url, NULL mint_count and NULL FMV. A holder of
-- `140:5141` -- Victor Wembanyama's 1/1 2023 Rookie Ultimate, Atlas ask
-- $150,000 -- sees an empty tile. Also affected: `140:5253` Chet Holmgren,
-- `253:8625` Jovana Nogic, `253:8957` Madina Okot, `253:8958` Kiki Rice.
--
-- WHY THEY WERE NEVER THERE, and why this is not a regression from today's
-- retirement. The old catalog walked `searchMarketplaceEditions`, which
-- structurally does not surface Ultimate 1/1 trophy editions -- the documented
-- reason `/api/admin/backfill-badges-from-sets` was written in the first place.
-- The gap predates the dead host. `ensure_topshot_edition_stub()` cannot close it
-- either: it returns NULL when `sets` has no row for the set, and sets 140 and
-- 253 have none (their sibling editions carry `set_id IS NULL`, which is why
-- those two rows exist and work).
--
-- WHERE THE VALUES COME FROM -- our own Atlas-fed table, not from me.
-- Identity (player, team, set_name, tier, circulation) is read from
-- `badge_editions`, which `atlas_editions_drain` keeps current. `series`,
-- `play_type`, `edition_kind` and `set_id` are copied from a sibling edition in
-- the SAME set, so nothing is invented -- and the derivation was checked against
-- Atlas before being trusted: `editionTemplate.metadata.PlayType` reads `Reel`
-- for all 18 base rows across both sets, matching both siblings exactly.
-- `description`, `thumbnail_url` and `video_url` are deliberately left NULL: the
-- Atlas enrichment shipped hours ago (`20260905024630`) fills them on the next
-- walk of these sets, which makes this insert its own positive control.
--
-- ⚠ SCOPE IS ENFORCED BY PREDICATE AND ASSERTED BY COUNT, not by a hand-typed
-- list of ids. A row qualifies only if it is base-keyed, ULTIMATE, mint 1,
-- absent from `editions`, and in a set where we already hold a sibling to derive
-- from. That predicate returns exactly 16 today; if it ever returns anything
-- else the migration RAISES rather than creating what it did not measure.
-- ⛔ The 563 missing PARALLELS are NOT created here. They need subedition
-- keying, they move circulation ladders and the sitemap, and they remain an open
-- decision.
--
-- REVERT:
--   DELETE FROM public.editions e
--    USING public.audit_20260904_ultimate_1of1_editions_created a
--    WHERE e.id = a.edition_id;
-- (Nothing else references them yet; the wmc denorm re-nulls on its next
-- reconcile, returning those five tiles to the blank state recorded above.)
CREATE TABLE IF NOT EXISTS public.audit_20260904_ultimate_1of1_editions_created (
  edition_id uuid PRIMARY KEY,
  external_id text NOT NULL,
  player_name text,
  set_name text,
  had_holders integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $mig$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_n  integer;
BEGIN
  WITH cand AS (
    SELECT be.external_id,
           split_part(be.external_id, ':', 1)::int AS sid,
           be.player_name, be.team, be.set_name, be.tier, be.circulation_count
      FROM public.badge_editions be
     WHERE be.collection_id = v_ts
       AND COALESCE(be.parallel_name, '') = ''
       AND be.tier = 'ULTIMATE'
       AND be.circulation_count = 1
       AND be.external_id ~ '^[0-9]+:[0-9]+$'
       AND be.player_name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.editions e
                        WHERE e.collection_id = be.collection_id AND e.external_id = be.external_id)
  ),
  withsib AS (
    SELECT c.*, s.series, s.play_type, s.set_id, s.edition_kind
      FROM cand c
      JOIN LATERAL (
        SELECT e.series, e.play_type, e.set_id, e.edition_kind
          FROM public.editions e
         WHERE e.collection_id = v_ts AND e.set_id_onchain = c.sid AND e.series IS NOT NULL
         ORDER BY e.external_id
         LIMIT 1
      ) s ON true
  ),
  ins AS (
    INSERT INTO public.editions
      (external_id, collection_id, collection, set_id, set_name, name, player_name, team_name,
       play_type, tier, series, edition_kind, circulation_count, created_at, updated_at)
    SELECT w.external_id, v_ts, 'nba_top_shot', w.set_id, w.set_name,
           w.player_name || ' — ' || w.set_name,
           w.player_name, w.team, w.play_type, w.tier::tier_type, w.series,
           COALESCE(w.edition_kind, 'LE'::edition_kind), w.circulation_count, now(), now()
      FROM withsib w
    ON CONFLICT DO NOTHING
    RETURNING id, external_id, player_name, set_name
  )
  INSERT INTO public.audit_20260904_ultimate_1of1_editions_created
    (edition_id, external_id, player_name, set_name, had_holders)
  SELECT i.id, i.external_id, i.player_name, i.set_name,
         (SELECT count(*)::int FROM public.wallet_moments_cache w WHERE w.edition_key = i.external_id)
    FROM ins i
  ON CONFLICT (edition_id) DO NOTHING;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 16 THEN
    RAISE EXCEPTION 'expected to create exactly 16 Ultimate 1/1 editions, created % -- the population drifted, refusing to create what was not measured', v_n;
  END IF;
END
$mig$;
