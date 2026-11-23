-- STAGED 2026-11-23 ~1:40 PM PT (Claude Code cloud; Trevor: "try to resolve these still open"). For Cowork:
-- run in the Supabase SQL editor (the MCP holds the DELETE), or apply_migration as
-- `audit_20261123_merge_two_split_suffix_players` in an attended session. Found by the #258 follow-up: a sweep of
-- players pairs whose folded names differ only by a generational suffix (Jr/Sr/II/III/IV), 14 pairs estate-wide.
-- 12 are genuine father/son or namesakes (different eras/teams: Payton, Hardaway, Nance, Harrison, Winfield,
-- Samuel, Porter, Harper, Robinson, the two Luis Garcías). TWO are ONE person split across two rows, so the player
-- page shows a fraction of their editions as the whole (get_player_editions picks one row by slug):
--   Candy  keep "Luis Robert"       de409d7c… (19 editions, Chicago White Sox) · drop "Luis Robert Jr." d8b2efc5… (2, Chicago White Sox)
--   Panini keep "Andre Jackson Jr." 13c1f240… (13, Prizm base + rookies)      · drop "Andre Jackson"   d88fc832… (4, Rated Rookies / Retro 1988 — his 2023-24 rookie cards)
-- Each drop row was read 11-23 ~1:35 PM PT: 0 aliases / relations / identities / pooled-effect / panini-bridge / badge refs.
-- Same pattern as R153 (20261115183435): re-point editions by player_id, back up, delete the drop row, register its
-- slug(s) as aliases so the old URL 308s and the linker/minting stop re-creating it. Edition labels are NOT rewritten.
-- Revert: INSERT INTO players SELECT <players cols> FROM audit_20261123_suffix_merge_players_backup;
--         UPDATE editions e SET player_id = b.player_id FROM audit_20261123_suffix_merge_editions_backup b WHERE b.edition_id = e.id;
--         DELETE FROM player_name_aliases WHERE note LIKE 'suffix-merge 2026-11-23%';

CREATE TABLE IF NOT EXISTS public.audit_20261123_suffix_merge_players_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20261123_suffix_merge_players_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261123_suffix_merge_players_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.audit_20261123_suffix_merge_editions_backup (
  edition_id uuid PRIMARY KEY, player_id uuid NOT NULL, backed_up_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.audit_20261123_suffix_merge_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261123_suffix_merge_editions_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE r RECORD; v_moved int; v_keep text; v_drop text; v_slug_keep text; v_slug_drop text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('de409d7c-e111-4b16-bd4c-1442dd2ecb43'::uuid, 'd8b2efc5-ae1f-4e7f-94c4-e80cbd3b29b7'::uuid),  -- Luis Robert (Candy)
      ('13c1f240-d82c-4225-8d5f-700ce7f1d0aa',       'd88fc832-413d-45a8-b6e3-1d64bd4c30c4')         -- Andre Jackson Jr. (Panini)
    ) v(keep_id, drop_id)
  LOOP
    SELECT name INTO v_keep FROM public.players WHERE id = r.keep_id;
    SELECT name INTO v_drop FROM public.players WHERE id = r.drop_id;
    IF v_keep IS NULL THEN RAISE EXCEPTION 'suffix-merge: keep row % not found', r.keep_id; END IF;
    IF v_drop IS NULL THEN RAISE NOTICE 'suffix-merge: drop row % already gone', r.drop_id; CONTINUE; END IF;
    IF (SELECT collection_id FROM public.players WHERE id = r.keep_id) IS DISTINCT FROM (SELECT collection_id FROM public.players WHERE id = r.drop_id) THEN
      RAISE EXCEPTION 'suffix-merge: % and % are in different collections', v_keep, v_drop; END IF;
    IF EXISTS (SELECT 1 FROM public.player_name_aliases WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.player_relations WHERE player_id = r.drop_id OR related_player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.player_identities WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id = r.drop_id::text) THEN
      RAISE EXCEPTION 'suffix-merge: "%" is referenced outside editions — extend the merge first', v_drop; END IF;
    INSERT INTO public.audit_20261123_suffix_merge_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = r.drop_id;
    INSERT INTO public.audit_20261123_suffix_merge_editions_backup (edition_id, player_id)
      SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = r.drop_id ON CONFLICT (edition_id) DO NOTHING;
    UPDATE public.editions SET player_id = r.keep_id WHERE player_id = r.drop_id;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    DELETE FROM public.players WHERE id = r.drop_id;
    v_slug_keep := regexp_replace(lower(trim(extensions.unaccent(v_keep))), '[^a-z0-9]+', '-', 'g');
    v_slug_drop := regexp_replace(lower(trim(extensions.unaccent(v_drop))), '[^a-z0-9]+', '-', 'g');
    IF v_slug_drop <> v_slug_keep THEN
      INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
        SELECT p.collection_id, v_slug_drop, r.keep_id, 'suffix-merge 2026-11-23: source spelling "' || v_drop || '"'
          FROM public.players p WHERE p.id = r.keep_id ON CONFLICT (collection_id, alias_slug) DO NOTHING;
      -- the dashless form of a trailing-period slug ("luis-robert-jr-" -> "luis-robert-jr"), as 20261115180236 did
      IF right(v_slug_drop, 1) = '-' THEN
        INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
          SELECT p.collection_id, rtrim(v_slug_drop, '-'), r.keep_id, 'suffix-merge 2026-11-23: dashless "' || v_drop || '"'
            FROM public.players p WHERE p.id = r.keep_id ON CONFLICT (collection_id, alias_slug) DO NOTHING;
      END IF;
    END IF;
    RAISE NOTICE 'suffix-merge: merged "%" into "%" (% editions)', v_drop, v_keep, v_moved;
  END LOOP;
END $$;

-- Post-conditions
DO $$ DECLARE v_n int; BEGIN
  SELECT count(*) INTO v_n FROM public.players WHERE id IN ('d8b2efc5-ae1f-4e7f-94c4-e80cbd3b29b7','d88fc832-413d-45a8-b6e3-1d64bd4c30c4');
  IF v_n <> 0 THEN RAISE EXCEPTION 'suffix-merge: % drop rows still exist', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.editions WHERE player_id = 'de409d7c-e111-4b16-bd4c-1442dd2ecb43';
  IF v_n < 21 THEN RAISE EXCEPTION 'suffix-merge: Luis Robert has % editions (expected >= 21)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.editions WHERE player_id = '13c1f240-d82c-4225-8d5f-700ce7f1d0aa';
  IF v_n < 17 THEN RAISE EXCEPTION 'suffix-merge: Andre Jackson Jr. has % editions (expected >= 17)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.player_name_aliases WHERE note LIKE 'suffix-merge 2026-11-23%';
  IF v_n <> 3 THEN RAISE EXCEPTION 'suffix-merge: % alias rows (expected 3: luis-robert-jr-, luis-robert-jr, andre-jackson)', v_n; END IF;
END $$;
