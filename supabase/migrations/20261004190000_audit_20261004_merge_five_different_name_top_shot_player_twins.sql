-- audit_20261004_merge_five_different_name_top_shot_player_twins
--
-- 2026-10-04 ~11:50 AM PT (Claude Code cloud; Trevor: "keep going" / "Approve" / "Do it all"; register D26).
-- APPLIED 2026-10-04 12:36 PM PT via the dashboard SQL editor (Run approved by Trevor under manual
-- approval, one transaction with 190100 + 190200): MCP apply_migration was held by the
-- destructive-statement confirmation gate three times (DELETE). No schema_migrations row.
--
-- WHAT. Five Top Shot people still had TWO players rows each, under DIFFERENT names, so
-- their editions sat on two /player/ pages — the same defect the 09-24 merge
-- (20260925063021, same-name pairs) and the Curry merge (20260925135939, the first
-- different-name pair) fixed for others. Found by grouping canonical TS editions on
-- lower(unaccent(player_name)) and counting distinct player_id:
--
--   keep (NBA stats id)                 twin (fossil row)                      twin editions
--   OG Anunoby            1628384       O.G. Anunoby        flow:3582          3   (keep has 53)
--   Nic Claxton           1629651       Nicolas Claxton     flow:946           4   (keep has 20)
--   Rob Dillingham        1642265       Robert Dillingham   flow:5732          1   (keep has 4)
--   Bub Carrington        1642267       Carlton Carrington  flow:5721          3   (keep has 3)
--   Maya Caldwell-Ellwanger 1630471     Maya Caldwell       nba_top_shot-maya-caldwell  2
--
-- Every twin's editions carry a label that also appears on the keep row's editions
-- ("OG Anunoby", "Nic Claxton", "Rob Dillingham", "Carlton Carrington", "Maya Caldwell"),
-- i.e. one person split by row, not two people. Caldwell-Ellwanger is a married-name
-- change of the same WNBA player (same stats id on the keep row).
--
-- POLICY (decided 09-25, delegated; docs/reference/player-identity.md): no renames to
-- another spelling — the canonical NBA-id row keeps its name and an ALIAS carries the
-- other spelling, so the twin's old URL 308s (get_player_alias_target) and the name
-- writers (resolve_canonical_player, ensure_players_from_edition_names,
-- link_editions_to_players_by_name) never re-mint it. Edition labels are NOT rewritten.
--
-- PRE-CHECKED (11:47 AM PT): for all five twins 0 rows in badge_editions,
-- serial_fmv_pooled_player_effect, panini_bridge_candidate_editions, player_identities,
-- player_relations (which CASCADEs — it would have lost rows) and player_name_aliases;
-- no alias already registered for any twin slug; all ten rows in the Top Shot collection.
-- Re-asserted below before anything moves.
--
-- Aliases registered (twin's own slug): o-g-anunoby, nicolas-claxton, robert-dillingham,
-- carlton-carrington, maya-caldwell.
--
-- Backups (RLS on): audit_20261004_player_twins_backup (the five deleted rows),
-- audit_20261004_player_twin_editions_backup (edition_id, old player_id).
-- REVERT: INSERT INTO players SELECT <players columns> FROM audit_20261004_player_twins_backup;
-- UPDATE editions e SET player_id = b.player_id FROM audit_20261004_player_twin_editions_backup b
--   WHERE b.edition_id = e.id;
-- DELETE FROM player_name_aliases WHERE note LIKE 'audit_20261004 twin merge%';

CREATE TABLE IF NOT EXISTS public.audit_20261004_player_twins_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20261004_player_twins_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_player_twins_backup FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.audit_20261004_player_twin_editions_backup (
  edition_id   uuid PRIMARY KEY,
  player_id    uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261004_player_twin_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_player_twin_editions_backup FROM PUBLIC, anon, authenticated;

DO $mig$
DECLARE
  v_ts    constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_pairs int;
  v_refs  int;
  v_moved int;
  v_left  int;
BEGIN
  CREATE TEMP TABLE _twins (twin uuid PRIMARY KEY, keep uuid NOT NULL, twin_ext text NOT NULL, keep_ext text NOT NULL) ON COMMIT DROP;
  INSERT INTO _twins VALUES
    ('81e5ef78-793b-46fa-860b-fee97feadd07', '19518b0e-2152-464a-bbc3-4e3f3f34b19c', 'flow:3582',                  '1628384'),
    ('d75042c9-a902-4114-834c-63ca5b07ee9e', 'd17cbdf2-1548-428c-81ee-adf48cc50189', 'flow:946',                   '1629651'),
    ('e091d9b6-433b-4747-95ef-c36de628f02b', '99dfb5a5-887c-461f-8cf5-3093b027e7e9', 'flow:5732',                  '1642265'),
    ('9fd2424a-8d53-418d-9214-0eb35d51b9a7', 'a1a8e7f4-8fd6-41cc-af45-76fc826c6389', 'flow:5721',                  '1642267'),
    ('ef11be01-2098-4629-a143-9fb4b93644b8', 'd96477de-fcee-4eea-b8ab-7bcc2473b786', 'nba_top_shot-maya-caldwell', '1630471');

  -- Idempotent: if every twin is already gone, this migration has run.
  IF NOT EXISTS (SELECT 1 FROM public.players p JOIN _twins t ON t.twin = p.id) THEN
    RAISE NOTICE 'twins already merged — no-op';
    RETURN;
  END IF;

  -- Pre-conditions: each row is exactly the row measured (id + external_id + collection).
  SELECT count(*) INTO v_pairs
    FROM _twins t
    JOIN public.players pt ON pt.id = t.twin AND pt.external_id = t.twin_ext AND pt.collection_id = v_ts
    JOIN public.players pk ON pk.id = t.keep AND pk.external_id = t.keep_ext AND pk.collection_id = v_ts;
  IF v_pairs <> 5 THEN
    RAISE EXCEPTION 'expected 5 intact twin/keep pairs, found %', v_pairs;
  END IF;

  SELECT (SELECT count(*) FROM public.badge_editions b WHERE b.player_id::text IN (SELECT twin::text FROM _twins))
       + (SELECT count(*) FROM public.serial_fmv_pooled_player_effect s WHERE s.player_id::text IN (SELECT twin::text FROM _twins))
       + (SELECT count(*) FROM public.panini_bridge_candidate_editions x WHERE x.player_id::text IN (SELECT twin::text FROM _twins))
       + (SELECT count(*) FROM public.player_identities i WHERE i.player_id IN (SELECT twin FROM _twins))
       + (SELECT count(*) FROM public.player_relations r WHERE r.player_id IN (SELECT twin FROM _twins) OR r.related_player_id IN (SELECT twin FROM _twins))
       + (SELECT count(*) FROM public.player_name_aliases a WHERE a.player_id IN (SELECT twin FROM _twins))
    INTO v_refs;
  IF v_refs <> 0 THEN
    RAISE EXCEPTION 'twins have % non-edition references; merge them by hand', v_refs;
  END IF;

  INSERT INTO public.audit_20261004_player_twins_backup
  SELECT p.*, now() FROM public.players p WHERE p.id IN (SELECT twin FROM _twins);

  INSERT INTO public.audit_20261004_player_twin_editions_backup (edition_id, player_id)
  SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id IN (SELECT twin FROM _twins)
  ON CONFLICT (edition_id) DO NOTHING;

  WITH moved AS (
    UPDATE public.editions e SET player_id = t.keep
      FROM _twins t
     WHERE e.player_id = t.twin
    RETURNING 1
  ) SELECT count(*) INTO v_moved FROM moved;

  -- Alias the twin's own slug to the kept row BEFORE the delete, using the table's
  -- documented slug expression.
  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  SELECT v_ts,
         regexp_replace(lower(trim(extensions.unaccent(pt.name))), '[^a-z0-9]+', '-', 'g'),
         t.keep,
         'audit_20261004 twin merge (D26): second name of one person; canonical row keeps its name (09-25 policy)'
    FROM _twins t JOIN public.players pt ON pt.id = t.twin
  ON CONFLICT (collection_id, alias_slug) DO NOTHING;

  DELETE FROM public.players WHERE id IN (SELECT twin FROM _twins);

  -- Post-conditions.
  SELECT count(*) INTO v_left FROM public.editions e WHERE e.player_id IN (SELECT twin FROM _twins);
  IF v_left <> 0 THEN RAISE EXCEPTION '% editions still point at a twin', v_left; END IF;
  IF (SELECT count(*) FROM public.player_name_aliases a
       WHERE a.collection_id = v_ts AND a.note LIKE 'audit_20261004 twin merge%'
         AND a.player_id IN (SELECT keep FROM _twins)) <> 5 THEN
    RAISE EXCEPTION 'expected 5 aliases on the kept rows';
  END IF;
  IF v_moved <> 13 THEN RAISE EXCEPTION 'expected 13 editions repointed, moved %', v_moved; END IF;
  RAISE NOTICE 'merged 5 twins, repointed % editions, 5 aliases', v_moved;
END
$mig$;
