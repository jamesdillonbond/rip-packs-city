-- 2026-09-24 (PT) — 12 Top Shot players existed twice under the SAME name
-- (Jimmy Butler, Alperen Şengün, Steph Curry, Manu Ginóbili, …): a canonical
-- row keyed on the NBA stats id, and a second row keyed 'nba_top_shot-<slug>'
-- or 'flow:<playID>' that ensure_players_from_edition_names /
-- resolve_canonical_player seeded (Apr–Aug 2026) while the canonical row's
-- collection_id was presumably still NULL, so the per-collection name check
-- found nothing. Two rows = two /player/ pages splitting one player's editions
-- (Butler 41 + 1, Şengün 31 + 4) and two hits in search.
--
-- Merge: per (collection_id, name) group keep the row resolve_canonical_player
-- itself prefers (numeric external_id, then most editions, then oldest),
-- repoint the 5 editions on the extras, delete the 12 extras. Backups carry
-- the pre-state (RLS on): audit_20260924_dup_players_backup (the 12 rows) and
-- audit_20260924_dup_player_editions_backup (edition_id, old player_id).
-- No other table references the extras (badge_editions,
-- serial_fmv_pooled_player_effect, panini_bridge_candidate_editions: 0 rows).
--
-- NOT merged: "Steph Curry" (74 editions) vs "Stephen Curry" (23) — different
-- names, one person; Top Shot's official spelling is "Stephen Curry". That is
-- a naming decision for Trevor (known-issues).
-- Revert: INSERT the players back from audit_20260924_dup_players_backup, then
-- UPDATE editions e SET player_id = b.player_id FROM
-- audit_20260924_dup_player_editions_backup b WHERE b.edition_id = e.id.

CREATE TABLE IF NOT EXISTS public.audit_20260924_dup_players_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20260924_dup_players_backup ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.audit_20260924_dup_player_editions_backup (
  edition_id uuid PRIMARY KEY,
  player_id  uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260924_dup_player_editions_backup ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_extras int;
  v_moved  int;
  v_left   int;
BEGIN
  CREATE TEMP TABLE _dups ON COMMIT DROP AS
  SELECT p.id, p.name, p.collection_id,
         row_number() OVER (
           PARTITION BY p.collection_id, p.name
           ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$' THEN 1
                         WHEN p.external_id LIKE 'flow:%' THEN 3
                         ELSE 2 END,
                    (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
                    p.created_at, p.id
         ) AS rn
    FROM public.players p
    JOIN (SELECT name, collection_id FROM public.players
           GROUP BY 1, 2 HAVING count(*) > 1) d
      ON d.name = p.name AND d.collection_id = p.collection_id;

  SELECT count(*) INTO v_extras FROM _dups WHERE rn > 1;
  IF v_extras = 0 THEN
    RAISE NOTICE 'no duplicate players — no-op';
    RETURN;
  END IF;

  INSERT INTO public.audit_20260924_dup_players_backup
  SELECT p.*, now() FROM public.players p WHERE p.id IN (SELECT id FROM _dups WHERE rn > 1);

  INSERT INTO public.audit_20260924_dup_player_editions_backup (edition_id, player_id)
  SELECT e.id, e.player_id FROM public.editions e
   WHERE e.player_id IN (SELECT id FROM _dups WHERE rn > 1)
  ON CONFLICT (edition_id) DO NOTHING;

  WITH moved AS (
    UPDATE public.editions e
       SET player_id = k.id
      FROM _dups x
      JOIN _dups k ON k.collection_id = x.collection_id AND k.name = x.name AND k.rn = 1
     WHERE x.rn > 1 AND e.player_id = x.id
    RETURNING 1
  )
  SELECT count(*) INTO v_moved FROM moved;

  DELETE FROM public.players WHERE id IN (SELECT id FROM _dups WHERE rn > 1);

  SELECT count(*) INTO v_left FROM (
    SELECT 1 FROM public.players GROUP BY collection_id, name HAVING count(*) > 1
  ) z;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'duplicate player groups remain: %', v_left;
  END IF;
  RAISE NOTICE 'merged % duplicate player rows, repointed % editions', v_extras, v_moved;
END $$;
