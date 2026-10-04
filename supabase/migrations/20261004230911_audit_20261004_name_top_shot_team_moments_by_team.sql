-- audit_20261004_name_top_shot_team_moments_by_team
--
-- 2026-10-04 ~4:10 PM PT (Claude Code cloud; Trevor: "Do what you think is best and address these as you can").
--
-- WHAT (register R8). 590 Top Shot TEAM Moments (no player) exist; 584 were named by their set alone,
-- so a set page listed 66 Moments all called "Clamps", 34 "Fit Check", 27 "Dynamic Duos" — the
-- Moments were indistinguishable by name. Six were already named "<team> — <set>" (WNBA Skyline),
-- so the catalogue was also inconsistent. Every one of the 584 carries its team in `team_name`
-- (47 teams; none is Dapper's "<invalid Value>" sentinel).
--
-- CHANGE. name := trim(team_name) || ' — ' || set_name on those 584 rows — the same shape as a
-- player Moment ("Jayson Tatum — Clamps"). The two writers that rewrite `editions.name` (the sale
-- ingest's upsert and lib/editions-hydrate.ts) now name a team Moment the same way
-- (lib/topshot-edition-name.ts, same commit), so a later sale does not put "Clamps" back. No DB
-- function writes a non-NULL name over an existing one (stub resolver, Atlas catalog and the
-- parallel-identity sync are fill-only), checked 2026-10-04.
-- Not changed: player_id stays NULL and player_name is untouched. ensure_players_from_edition_names
-- reads player_name, not name, so no "player" is minted from a team.
--
-- Backup (RLS on, revoked): audit_20261004_team_moment_names_backup (edition_id, old_name).
-- REVERT: UPDATE public.editions e SET name = b.old_name
--           FROM public.audit_20261004_team_moment_names_backup b WHERE e.id = b.edition_id;
--         and revert the commit titled "top shot: name team moments by their team".

CREATE TABLE IF NOT EXISTS public.audit_20261004_team_moment_names_backup (
  edition_id uuid PRIMARY KEY, old_name text, backed_up_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.audit_20261004_team_moment_names_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261004_team_moment_names_backup FROM PUBLIC, anon, authenticated;

DO $tm$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_backed int; v_renamed int;
BEGIN
  INSERT INTO public.audit_20261004_team_moment_names_backup (edition_id, old_name)
    SELECT id, name FROM public.editions
     WHERE collection_id = c_ts AND player_id IS NULL AND name = set_name
       AND NULLIF(trim(team_name), '') IS NOT NULL AND team_name <> '<invalid Value>'
    ON CONFLICT (edition_id) DO NOTHING;
  GET DIAGNOSTICS v_backed = ROW_COUNT;

  WITH r AS (
    UPDATE public.editions e
       SET name = trim(e.team_name) || ' — ' || e.set_name, updated_at = now()
      FROM public.audit_20261004_team_moment_names_backup b
     WHERE e.id = b.edition_id AND e.collection_id = c_ts AND e.name = e.set_name
    RETURNING 1) SELECT count(*) INTO v_renamed FROM r;

  IF v_renamed < 500 OR v_renamed > 650 THEN
    RAISE EXCEPTION 'expected ~584 team Moments renamed, got % (backed up %)', v_renamed, v_backed;
  END IF;
  IF EXISTS (SELECT 1 FROM public.editions
              WHERE collection_id = c_ts AND player_id IS NULL AND name = set_name
                AND NULLIF(trim(team_name), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'a team Moment is still named by its set alone';
  END IF;
  RAISE NOTICE 'renamed % Top Shot team Moments to "<team> — <set>"', v_renamed;
END
$tm$;
