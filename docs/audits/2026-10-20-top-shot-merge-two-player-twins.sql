-- 2026-10-20 ~11:00 PM PT (Claude Code cloud) — known-issues #199: two Top Shot people still
-- have a same-person twin `players` row. FOR TREVOR: paste into the dashboard SQL editor and
-- Run (it contains a DELETE, which the MCP holds for a human). One all-or-nothing block;
-- it re-checks every precondition and raises before anything moves if the rows changed.
-- Same shape as the 10-04 merge (20261004190000, register D26; docs/reference/player-identity.md).
--
--   keep (NBA stats id)                         twin (fossil row)                                     twin editions
--   Ronald Holland II   997a7614…  ext 1641842  Ron Holland II      077a033f…  ext nba_top_shot-ron-holland-ii   0 (keep has 8)
--   Mahmoud Abdul-Rauf  8d4851d1…  ext 51       Mahmoud Abul-Rauf   e90af2b4…  ext flow:5587                     1 (keep has 0)
--
-- Policy (09-25): the NBA-id row keeps its name; the twin's own slug becomes an ALIAS of the
-- kept row, so the twin's old URL 308s and the name writers never re-mint it. Edition labels
-- are not rewritten. "Abul-Rauf" is a misspelling; "Ron Holland II" is the name he goes by,
-- which the alias carries.
--
-- Pre-checked 10-20 ~10:55 PM PT: the twins hold 0 rows in badge_editions,
-- serial_fmv_pooled_player_effect, player_identities, player_relations (CASCADE) and
-- player_name_aliases. FKs into players: editions, player_name_aliases (NO ACTION),
-- player_relations (CASCADE), player_identities (SET NULL) — all re-asserted below.
--
-- REVERT: INSERT INTO players SELECT <players columns> FROM audit_20261020_player_twins_backup;
--   UPDATE editions e SET player_id = b.player_id FROM audit_20261020_player_twin_editions_backup b
--    WHERE b.edition_id = e.id;
--   DELETE FROM player_name_aliases WHERE note LIKE 'audit_20261020 twin merge%';

CREATE TABLE IF NOT EXISTS public.audit_20261020_player_twins_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20261020_player_twins_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261020_player_twins_backup FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.audit_20261020_player_twin_editions_backup (
  edition_id   uuid PRIMARY KEY,
  player_id    uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261020_player_twin_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261020_player_twin_editions_backup FROM PUBLIC, anon, authenticated;

DO $merge$
DECLARE
  v_ts    constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_pairs int;
  v_refs  int;
  v_moved int;
  v_left  int;
BEGIN
  CREATE TEMP TABLE _twins (twin uuid PRIMARY KEY, keep uuid NOT NULL, twin_ext text NOT NULL, keep_ext text NOT NULL) ON COMMIT DROP;
  INSERT INTO _twins VALUES
    ('077a033f-f8b9-4e62-b9c9-444619ce07a8', '997a7614-5084-40a7-b74d-b1db2a57c89d', 'nba_top_shot-ron-holland-ii', '1641842'),
    ('e90af2b4-96ba-423b-95d1-4d1b77f9cf53', '8d4851d1-e35b-42f9-b9d9-978cfe7499ee', 'flow:5587',                   '51');

  IF NOT EXISTS (SELECT 1 FROM public.players p JOIN _twins t ON t.twin = p.id) THEN
    RAISE NOTICE 'twins already merged — no-op';
    RETURN;
  END IF;

  SELECT count(*) INTO v_pairs
    FROM _twins t
    JOIN public.players pt ON pt.id = t.twin AND pt.external_id = t.twin_ext AND pt.collection_id = v_ts
    JOIN public.players pk ON pk.id = t.keep AND pk.external_id = t.keep_ext AND pk.collection_id = v_ts;
  IF v_pairs <> 2 THEN
    RAISE EXCEPTION 'expected 2 intact twin/keep pairs, found %', v_pairs;
  END IF;

  SELECT (SELECT count(*) FROM public.badge_editions b WHERE b.player_id::text IN (SELECT twin::text FROM _twins))
       + (SELECT count(*) FROM public.serial_fmv_pooled_player_effect s WHERE s.player_id::text IN (SELECT twin::text FROM _twins))
       + (SELECT count(*) FROM public.player_identities i WHERE i.player_id IN (SELECT twin FROM _twins))
       + (SELECT count(*) FROM public.player_relations r WHERE r.player_id IN (SELECT twin FROM _twins) OR r.related_player_id IN (SELECT twin FROM _twins))
       + (SELECT count(*) FROM public.player_name_aliases a WHERE a.player_id IN (SELECT twin FROM _twins))
    INTO v_refs;
  IF v_refs <> 0 THEN
    RAISE EXCEPTION 'twins have % non-edition references; merge them by hand', v_refs;
  END IF;

  INSERT INTO public.audit_20261020_player_twins_backup
  SELECT p.*, now() FROM public.players p WHERE p.id IN (SELECT twin FROM _twins);

  INSERT INTO public.audit_20261020_player_twin_editions_backup (edition_id, player_id)
  SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id IN (SELECT twin FROM _twins)
  ON CONFLICT (edition_id) DO NOTHING;

  WITH moved AS (
    UPDATE public.editions e SET player_id = t.keep
      FROM _twins t
     WHERE e.player_id = t.twin
    RETURNING 1
  ) SELECT count(*) INTO v_moved FROM moved;

  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  SELECT v_ts,
         regexp_replace(lower(trim(extensions.unaccent(pt.name))), '[^a-z0-9]+', '-', 'g'),
         t.keep,
         'audit_20261020 twin merge (#199): second name of one person; canonical row keeps its name (09-25 policy)'
    FROM _twins t JOIN public.players pt ON pt.id = t.twin
  ON CONFLICT (collection_id, alias_slug) DO NOTHING;

  DELETE FROM public.players WHERE id IN (SELECT twin FROM _twins);

  SELECT count(*) INTO v_left FROM public.editions e WHERE e.player_id IN (SELECT twin FROM _twins);
  IF v_left <> 0 THEN RAISE EXCEPTION '% editions still point at a twin', v_left; END IF;
  IF (SELECT count(*) FROM public.player_name_aliases a
       WHERE a.collection_id = v_ts AND a.note LIKE 'audit_20261020 twin merge%'
         AND a.player_id IN (SELECT keep FROM _twins)) <> 2 THEN
    RAISE EXCEPTION 'expected 2 aliases on the kept rows';
  END IF;
  IF v_moved <> 1 THEN RAISE EXCEPTION 'expected 1 edition repointed, moved %', v_moved; END IF;
  RAISE NOTICE 'merged 2 twins, repointed % editions, 2 aliases', v_moved;
END
$merge$;
