-- 2026-09-25 (PT) — 17 players existed twice as ACCENT / CASE variants of one
-- name in one collection (Luka Dončić + "Luka Doncic", Alperen Şengün + "Alperen
-- Sengun" — 38 + 17 editions, two /player/ pages, two search hits — Dennis
-- Schröder, Nikola Vučević, Marine Johannès, Manu Ginóbili, Boban Marjanović,
-- Karlo Matković, Vít Krejčí, Temi Fágbénlé, Noémie Brochant, Frieda Bühner,
-- Ivana Dojkić, Marta Suárez, Aleksej Pokuševski, Alicia Flórez ×2 under one
-- spelling in two Unicode normal forms, and LaLiga's Luís Fabiano). The 09-24
-- merge (20260925063021) grouped on the EXACT name, so these were invisible to
-- it; the writer that mints them is resolve_canonical_player, whose lookup slug
-- does not fold accents ("dennis-schr-der" ≠ "dennis-schroder" — fixed in the
-- companion migration), and the daily exact-name linker then leaves every
-- accent-variant edition (13 today: Leïla Lacan, Dijonai Carrington, Toni
-- Kukoc, Kai Kara-france, Molly Mccann) with player_id NULL forever, because
-- the seeder (already accent-aware) rightly refuses to mint a second row.
--
-- Three parts. (1) Merge: per (collection_id, lower(unaccent(name))) group keep
-- the row resolve_canonical_player prefers (numeric external_id, then most
-- editions, then oldest), repoint the 55 editions on the 17 extras, delete the
-- extras. No other table references them (serial_fmv_pooled_player_effect,
-- panini_bridge_candidate_editions, badge_editions: 0 rows). (2) The linker
-- matches accent- and case-insensitively, still ONLY when exactly one players
-- row matches (never fuzzy). (3) One run of it now.
-- Backups (RLS on): audit_20260925_dup_players_v2_backup (the 17 rows) and
-- audit_20260925_dup_player_editions_v2_backup (edition_id, old player_id).
-- Revert: INSERT the players back from the first, then UPDATE editions e SET
-- player_id = b.player_id FROM audit_20260925_dup_player_editions_v2_backup b
-- WHERE b.edition_id = e.id; the 13 newly linked editions are in
-- audit_20260925_edition_player_link_backup (linked_at ≥ this migration).

CREATE TABLE IF NOT EXISTS public.audit_20260925_dup_players_v2_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20260925_dup_players_v2_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_dup_players_v2_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.audit_20260925_dup_player_editions_v2_backup (
  edition_id uuid PRIMARY KEY,
  player_id  uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_dup_player_editions_v2_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_dup_player_editions_v2_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_extras int;
  v_moved  int;
  v_left   int;
BEGIN
  CREATE TEMP TABLE _dups ON COMMIT DROP AS
  SELECT p.id, p.collection_id,
         lower(extensions.unaccent(btrim(p.name))) AS k,
         row_number() OVER (
           PARTITION BY p.collection_id, lower(extensions.unaccent(btrim(p.name)))
           ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$' THEN 1
                         WHEN p.external_id LIKE 'flow:%' THEN 3
                         ELSE 2 END,
                    (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
                    p.created_at, p.id
         ) AS rn
    FROM public.players p
    JOIN (SELECT collection_id, lower(extensions.unaccent(btrim(name))) AS k
            FROM public.players GROUP BY 1, 2 HAVING count(*) > 1) d
      ON d.k = lower(extensions.unaccent(btrim(p.name))) AND d.collection_id = p.collection_id;

  SELECT count(*) INTO v_extras FROM _dups WHERE rn > 1;
  IF v_extras = 0 THEN
    RAISE NOTICE 'no accent/case-variant duplicate players — no-op';
  ELSE
    IF EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect s WHERE s.player_id IN (SELECT id FROM _dups WHERE rn > 1))
       OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions s WHERE s.player_id IN (SELECT id FROM _dups WHERE rn > 1))
       OR EXISTS (SELECT 1 FROM public.badge_editions s WHERE s.player_id IN (SELECT id::text FROM _dups WHERE rn > 1)) THEN
      RAISE EXCEPTION 'an extra player row is referenced outside editions — extend the merge before running it';
    END IF;

    INSERT INTO public.audit_20260925_dup_players_v2_backup
    SELECT p.*, now() FROM public.players p WHERE p.id IN (SELECT id FROM _dups WHERE rn > 1);

    INSERT INTO public.audit_20260925_dup_player_editions_v2_backup (edition_id, player_id)
    SELECT e.id, e.player_id FROM public.editions e
     WHERE e.player_id IN (SELECT id FROM _dups WHERE rn > 1)
    ON CONFLICT (edition_id) DO NOTHING;

    WITH moved AS (
      UPDATE public.editions e
         SET player_id = k.id
        FROM _dups x
        JOIN _dups k ON k.collection_id = x.collection_id AND k.k = x.k AND k.rn = 1
       WHERE x.rn > 1 AND e.player_id = x.id
      RETURNING 1
    )
    SELECT count(*) INTO v_moved FROM moved;

    DELETE FROM public.players WHERE id IN (SELECT id FROM _dups WHERE rn > 1);

    SELECT count(*) INTO v_left FROM (
      SELECT 1 FROM public.players GROUP BY collection_id, lower(extensions.unaccent(btrim(name))) HAVING count(*) > 1
    ) z;
    IF v_left <> 0 THEN
      RAISE EXCEPTION 'accent/case-variant duplicate player groups remain: %', v_left;
    END IF;
    RAISE NOTICE 'merged % accent/case-variant player rows, repointed % editions', v_extras, v_moved;
  END IF;
END $$;

-- (2) The linker folds accents and case. Live body re-read 09-25 3:20 AM PT;
-- the only change is the two name predicates.
-- anon-exec: intentional — link_editions_to_players_by_name is a pg_cron/service_role writer; REVOKEd from PUBLIC, anon and authenticated below.
CREATE OR REPLACE FUNCTION public.link_editions_to_players_by_name(p_collection_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_linked  int := 0;
  v_ok      boolean := true;
  v_err     text;
BEGIN
  BEGIN
    WITH cand AS (
      SELECT e.id AS edition_id, p.id AS player_id
      FROM public.editions e
      JOIN public.players p
        ON p.collection_id = e.collection_id
       AND lower(extensions.unaccent(btrim(p.name))) = lower(extensions.unaccent(btrim(e.player_name)))
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND e.player_name IS DISTINCT FROM e.team_name
        AND lower(btrim(e.player_name)) <> 'team moment'
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
        -- exactly one players row of that name (accent- and case-folded) in that collection
        AND (SELECT count(*) FROM public.players p2
              WHERE p2.collection_id = e.collection_id
                AND lower(extensions.unaccent(btrim(p2.name))) = lower(extensions.unaccent(btrim(e.player_name)))) = 1
    ),
    upd AS (
      UPDATE public.editions e
         SET player_id = c.player_id
        FROM cand c
       WHERE e.id = c.edition_id AND e.player_id IS NULL
      RETURNING e.id, e.player_id
    ),
    bk AS (
      INSERT INTO public.audit_20260925_edition_player_link_backup (edition_id, player_id)
      SELECT id, player_id FROM upd
      ON CONFLICT (edition_id) DO NOTHING
    )
    SELECT count(*)::int INTO v_linked FROM upd;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
    v_linked := 0;
  END;

  PERFORM public.log_pipeline_run(
    'editions-player-link', v_started,
    v_linked, v_linked, 0, v_ok, v_err,
    NULL, NULL, NULL,
    jsonb_build_object('scope', COALESCE(p_collection_id::text, 'all'), 'rows_written', v_linked,
                       'elapsed_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000))
  );
  IF NOT v_ok THEN
    RAISE EXCEPTION 'link_editions_to_players_by_name: %', v_err;
  END IF;
  RETURN v_linked;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.link_editions_to_players_by_name(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.link_editions_to_players_by_name(uuid) TO service_role, postgres;

-- (3) One run now.
SELECT public.link_editions_to_players_by_name(NULL);

-- Post-condition: no named, unlinked edition has exactly one accent-folded match.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM public.editions e
   WHERE e.player_id IS NULL AND e.player_name IS NOT NULL AND btrim(e.player_name) <> ''
     AND e.player_name IS DISTINCT FROM e.team_name AND lower(btrim(e.player_name)) <> 'team moment'
     AND (SELECT count(*) FROM public.players p WHERE p.collection_id = e.collection_id
            AND lower(extensions.unaccent(btrim(p.name))) = lower(extensions.unaccent(btrim(e.player_name)))) = 1;
  IF n <> 0 THEN RAISE EXCEPTION '% editions still unlinked with exactly one accent-folded player match', n; END IF;
END $$;
