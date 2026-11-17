-- audit_20261004_merge_megan_dileo_panini_twin
--
-- 2026-10-04 ~12:10 PM PT (Claude Code cloud; Trevor: "Same with Megan dileo" / "Do it all"; D26).
-- APPLIED via the dashboard SQL editor in one run with 20261004190000 + 20261004190100. No
-- schema_migrations row.
--
-- WHAT. Panini had two players rows for one person: "Megan DiLeo" (panini-megan-dileo, 5 editions,
-- WNBA Prizm product 2420) and "Megan Gustafson" (panini-megan-gustafson, 2 editions, product 2139,
-- minted 10-04 by sync_panini_products_bridge). Gustafson -> DiLeo is a name change (docs/reference/
-- player-identity.md lists it). Keep the DiLeo row (current name, older, more editions); alias
-- 'megan-gustafson' -> it; repoint the 2 editions; remove the Gustafson row. This holds only because
-- 20261004190100 makes the products bridge read aliases (it would re-mint the row otherwise).
-- Top Shot is untouched: one row there already ("Megan Gustafson", NBA id 1629484, alias megan-dileo).
--
-- PRE-CHECKED 12:05 PM PT: the Gustafson Panini row has 0 badge / pooled / bridge-candidate /
-- identity / relation / alias references; no 'megan-gustafson' alias exists on Panini.
-- Backups (RLS on): audit_20261004_dileo_player_backup, audit_20261004_dileo_editions_backup.
-- REVERT: re-insert the players row from audit_20261004_dileo_player_backup; restore editions.player_id
-- from audit_20261004_dileo_editions_backup; remove the alias whose note starts 'audit_20261004 DiLeo'.

CREATE TABLE IF NOT EXISTS public.audit_20261004_dileo_player_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20261004_dileo_player_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_dileo_player_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.audit_20261004_dileo_editions_backup (
  edition_id uuid PRIMARY KEY, player_id uuid NOT NULL, backed_up_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.audit_20261004_dileo_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_dileo_editions_backup FROM PUBLIC, anon, authenticated;

DO $dileo$
DECLARE
  c_coll constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  c_keep constant uuid := '1387a630-2bb8-4624-8997-1a061bad51df';
  c_twin constant uuid := '80697c5f-fbb2-43a3-81fd-9f1181c2a3d1';
  v_refs int; v_moved int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = c_twin) THEN
    RAISE NOTICE 'DiLeo twin already merged — no-op'; RETURN;
  END IF;
  IF (SELECT count(*) FROM public.players WHERE (id = c_keep AND external_id = 'panini-megan-dileo' AND name = 'Megan DiLeo')
        OR (id = c_twin AND external_id = 'panini-megan-gustafson' AND name = 'Megan Gustafson')) <> 2 THEN
    RAISE EXCEPTION 'DiLeo pair is not as measured';
  END IF;
  SELECT (SELECT count(*) FROM public.badge_editions b WHERE b.player_id::text = c_twin::text)
       + (SELECT count(*) FROM public.serial_fmv_pooled_player_effect s WHERE s.player_id::text = c_twin::text)
       + (SELECT count(*) FROM public.panini_bridge_candidate_editions x WHERE x.player_id::text = c_twin::text)
       + (SELECT count(*) FROM public.player_identities i WHERE i.player_id = c_twin)
       + (SELECT count(*) FROM public.player_relations r WHERE r.player_id = c_twin OR r.related_player_id = c_twin)
       + (SELECT count(*) FROM public.player_name_aliases a WHERE a.player_id = c_twin)
    INTO v_refs;
  IF v_refs <> 0 THEN RAISE EXCEPTION 'DiLeo twin has % non-edition references', v_refs; END IF;
  INSERT INTO public.audit_20261004_dileo_player_backup SELECT p.*, now() FROM public.players p WHERE p.id = c_twin;
  INSERT INTO public.audit_20261004_dileo_editions_backup (edition_id, player_id)
    SELECT id, player_id FROM public.editions WHERE player_id = c_twin ON CONFLICT (edition_id) DO NOTHING;
  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
    VALUES (c_coll, 'megan-gustafson', c_keep, 'audit_20261004 DiLeo merge (D26): former name of one person; Panini bridge reads aliases from 20261004190100')
    ON CONFLICT (collection_id, alias_slug) DO NOTHING;
  WITH m AS (UPDATE public.editions SET player_id = c_keep WHERE player_id = c_twin RETURNING 1)
    SELECT count(*) INTO v_moved FROM m;
  DELETE FROM public.players WHERE id = c_twin;
  IF v_moved <> 2 THEN RAISE EXCEPTION 'expected 2 DiLeo editions repointed, moved %', v_moved; END IF;
  IF EXISTS (SELECT 1 FROM public.editions WHERE player_id = c_twin) THEN RAISE EXCEPTION 'editions still on the DiLeo twin'; END IF;
  RAISE NOTICE 'merged Megan Gustafson (Panini) into Megan DiLeo; % editions', v_moved;
END
$dileo$;
