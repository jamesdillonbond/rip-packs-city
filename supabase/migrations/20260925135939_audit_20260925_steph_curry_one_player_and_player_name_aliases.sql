-- 2026-09-25 (PT) — Steph Curry is ONE player (#137 (a), Trevor's call: "Steph Curry").
--
-- Top Shot had two players rows for him: "Steph Curry" (c722ea7c-331e-469e-8dad-87c6fe3e52a2,
-- external_id '201939', 92 editions) and "Stephen Curry" (904b67d1-1759-4eb0-8876-700c60c7e320,
-- external_id 'flow:7835' — the per-play fossil scheme, 31 editions). Both
-- spellings sat under BOTH rows, so /player/steph-curry and /player/stephen-curry
-- each showed part of his catalogue. Different NAMES, not spellings, so neither
-- the 09-24 exact-name merge nor the 09-25 accent merge could see them.
--
-- A merge alone would not hold: every name writer resolves on the name slug,
-- so the next "Stephen Curry" (wallet-search -> resolve_canonical_player on
-- every Top Shot search; the daily ensure_players_from_edition_names at 2:50 AM
-- PT over the 17 editions Top Shot labels "Stephen Curry") would mint the row
-- again. Hence a small ALIAS table the name writers consult first.
--
-- (1) public.player_name_aliases (collection_id, alias_slug) -> player_id. RLS on,
--     no anon/authenticated access; FK to players with NO cascade, so a future
--     merge that deletes an alias target fails loudly instead of losing it.
-- (2) resolve_canonical_player: alias lookup before the slug match (pinned:
--     supabase/tests/resolve_canonical_player.sql).
-- (3) ensure_players_from_edition_names: never seeds a player for an alias
--     spelling. Built from the LIVE body (prosrc md5 ea089fb4… re-read 09-25
--     6:55 AM PT; newer than the 20260802012214 file) — only the alias predicate added.
-- (4) link_editions_to_players_by_name: a second arm links an unlinked edition
--     through an alias when no players row carries that spelling. Live body ==
--     20260925101708 (md5 693dd694…).
-- (5) get_player_alias_target(collection, slug): the canonical slug for an alias
--     slug, for the player layout's 301 (service_role only).
-- (6) The merge: 31 editions repointed to the '201939' row, the fossil row
--     deleted, alias 'stephen-curry' registered. Edition labels are NOT rewritten:
--     "Stephen Curry" is how Top Shot labels those 17 moments, and search's
--     token match must keep finding them.
--
-- Nothing else references players: the one FK is editions.player_id;
-- serial_fmv_pooled_player_effect and badge_editions carry 0 rows for either id
-- (checked 09-25 6:55 AM PT; re-asserted below). upsert_player_canonical is NOT
-- changed: its only caller, /api/ingest, reads the decommissioned Top Shot host.
--
-- Backups (RLS on): audit_20260925_curry_player_backup (the deleted row),
-- audit_20260925_curry_editions_backup (edition_id, old player_id).
-- Revert: INSERT the row back from the first; UPDATE editions e SET player_id =
-- b.player_id FROM audit_20260925_curry_editions_backup b WHERE b.edition_id = e.id;
-- DELETE FROM player_name_aliases WHERE alias_slug = 'stephen-curry'; re-apply
-- 20260925101847 (resolver), 20260925101708 (linker) and the ensure body quoted
-- in (3) (= this file's with the alias predicate removed).

-- (1)
CREATE TABLE IF NOT EXISTS public.player_name_aliases (
  collection_id uuid NOT NULL REFERENCES public.collections(id),
  alias_slug    text NOT NULL CHECK (alias_slug <> ''),
  player_id     uuid NOT NULL REFERENCES public.players(id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, alias_slug)
);
COMMENT ON TABLE public.player_name_aliases IS
  'A second NAME for one person (not an accent/case variant — those fold). alias_slug = regexp_replace(lower(trim(unaccent(name))), ''[^a-z0-9]+'', ''-'', ''g''). Read by resolve_canonical_player, ensure_players_from_edition_names, link_editions_to_players_by_name and get_player_alias_target. Added 2026-09-25 for Steph/Stephen Curry (#137 a).';
ALTER TABLE public.player_name_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_name_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.player_name_aliases TO service_role;
CREATE INDEX IF NOT EXISTS player_name_aliases_player_id_idx ON public.player_name_aliases (player_id);

CREATE TABLE IF NOT EXISTS public.audit_20260925_curry_player_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20260925_curry_player_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_curry_player_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.audit_20260925_curry_editions_backup (
  edition_id   uuid PRIMARY KEY,
  player_id    uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_curry_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_curry_editions_backup FROM PUBLIC, anon, authenticated;

-- (2) Base re-read 09-25 6:55 AM PT: live prosrc md5 9c43680f… == 20260925101847.
-- anon-exec: unchanged (resolve_canonical_player) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege('anon') = false read 09-25.
CREATE OR REPLACE FUNCTION public.resolve_canonical_player(p_collection_id uuid, p_name text, p_team text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug      text;
  v_coll_slug text;
  v_id        uuid;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(extensions.unaccent(p_name))), '[^a-z0-9]+', '-', 'g');
  IF v_slug = '' THEN
    RETURN NULL;
  END IF;

  -- 2026-09-25: a registered ALIAS (a second spelling of one person, e.g.
  -- "Stephen Curry" -> the "Steph Curry" row) resolves before the slug match,
  -- so the no-match arm cannot re-mint a merged duplicate.
  SELECT a.player_id INTO v_id
    FROM public.player_name_aliases a
   WHERE a.collection_id = p_collection_id
     AND a.alias_slug = v_slug;

  IF v_id IS NULL THEN
  SELECT p.id INTO v_id
    FROM public.players p
   WHERE p.collection_id = p_collection_id
     AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug
   ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$'  THEN 1
                 WHEN p.external_id LIKE 'flow:%' THEN 3
                 ELSE 2 END,
            (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
            p.id
   LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    IF p_team IS NOT NULL AND trim(p_team) <> '' THEN
      UPDATE public.players SET team = p_team, updated_at = now()
       WHERE id = v_id AND team IS NULL;
    END IF;
    RETURN v_id;
  END IF;

  SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;

  INSERT INTO public.players (external_id, collection_id, name, team, collection)
  VALUES (coalesce(v_coll_slug, 'unknown') || '-' || v_slug,
          p_collection_id, trim(p_name), nullif(trim(coalesce(p_team, '')), ''),
          coalesce(v_coll_slug, 'unknown'))
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT p.id INTO v_id
      FROM public.players p
     WHERE p.collection_id = p_collection_id
       AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug
     LIMIT 1;
  END IF;

  RETURN v_id;
END
$function$;

-- (3)
-- anon-exec: unchanged (ensure_players_from_edition_names) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege('anon') = false read 09-25.
CREATE OR REPLACE FUNCTION public.ensure_players_from_edition_names(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted int;
BEGIN
  WITH missing AS (
    SELECT DISTINCT ON (
             e.collection_id,
             regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g')
           )
           e.collection_id                                                        AS collection_id,
           c.slug                                                                 AS coll_slug,
           regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g')     AS name_slug,
           trim(e.player_name)                                                    AS player_name
      FROM public.editions e
      JOIN public.collections c ON c.id = e.collection_id
     WHERE e.player_name IS NOT NULL
       AND trim(e.player_name) <> ''
       -- 2026-09-06: a team Moment carries its franchise as player_name; that
       -- is a /team/ page, not a player, and the literal placeholder is neither
       AND trim(e.player_name) IS DISTINCT FROM trim(e.team_name)
       AND lower(trim(e.player_name)) <> 'team moment'
       AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
       -- the slug must not already resolve; this predicate is byte-for-byte the
       -- one get_player_detail uses, so we seed exactly the 404 set
       AND NOT EXISTS (
             SELECT 1
               FROM public.players p
              WHERE p.collection_id = e.collection_id
                AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')
                  = regexp_replace(lower(trim(extensions.unaccent(e.player_name))), '[^a-z0-9]+', '-', 'g')
           )
       -- 2026-09-25: nor may it be a registered ALIAS of an existing player
       -- ("Stephen Curry" editions belong to the "Steph Curry" row)
       AND NOT EXISTS (
             SELECT 1
               FROM public.player_name_aliases a
              WHERE a.collection_id = e.collection_id
                AND a.alias_slug = regexp_replace(lower(trim(extensions.unaccent(e.player_name))), '[^a-z0-9]+', '-', 'g')
           )
     ORDER BY e.collection_id,
              regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'),
              trim(e.player_name)
     LIMIT p_limit
  ),
  ins AS (
    INSERT INTO public.players (external_id, collection_id, name, collection)
    SELECT m.coll_slug || '-' || m.name_slug,
           m.collection_id,
           m.player_name,
           m.coll_slug
      FROM missing m
    ON CONFLICT (external_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN v_inserted;
END
$function$;

-- (4)
-- anon-exec: unchanged (link_editions_to_players_by_name) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege('anon') = false read 09-25.
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
      UNION ALL
      -- 2026-09-25: a registered ALIAS links to its player, only when no
      -- players row carries that spelling itself (so the two arms never both fire)
      SELECT e.id AS edition_id, a.player_id
      FROM public.editions e
      JOIN public.player_name_aliases a
        ON a.collection_id = e.collection_id
       AND a.alias_slug = regexp_replace(lower(trim(extensions.unaccent(e.player_name))), '[^a-z0-9]+', '-', 'g')
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
        AND NOT EXISTS (SELECT 1 FROM public.players p2
                         WHERE p2.collection_id = e.collection_id
                           AND lower(extensions.unaccent(btrim(p2.name))) = lower(extensions.unaccent(btrim(e.player_name))))
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

-- (5)
-- anon-exec: intentional — get_player_alias_target is read by the server-side player layout through service_role; REVOKEd from PUBLIC, anon and authenticated below.
CREATE OR REPLACE FUNCTION public.get_player_alias_target(p_collection_id uuid, p_slug text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')
    FROM public.player_name_aliases a
    JOIN public.players p ON p.id = a.player_id
   WHERE a.collection_id = p_collection_id
     AND a.alias_slug = p_slug
$function$;
REVOKE EXECUTE ON FUNCTION public.get_player_alias_target(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_player_alias_target(uuid, text) TO service_role, postgres;

-- (6) The merge.
DO $$
DECLARE
  v_keep  CONSTANT uuid := 'c722ea7c-331e-469e-8dad-87c6fe3e52a2';
  v_drop  CONSTANT uuid := '904b67d1-1759-4eb0-8876-700c60c7e320';
  v_ts    CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_moved int;
  v_n     int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = v_keep AND name = 'Steph Curry' AND collection_id = v_ts) THEN
    RAISE EXCEPTION 'the Steph Curry row is not what this migration expects';
  END IF;

  IF EXISTS (SELECT 1 FROM public.players WHERE id = v_drop) THEN
    IF EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = v_drop)
       OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id IN (v_drop::text, 'flow:7835')) THEN
      RAISE EXCEPTION 'the Stephen Curry row is referenced outside editions — extend the merge first';
    END IF;

    INSERT INTO public.audit_20260925_curry_player_backup
    SELECT p.*, now() FROM public.players p WHERE p.id = v_drop;

    INSERT INTO public.audit_20260925_curry_editions_backup (edition_id, player_id)
    SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = v_drop
    ON CONFLICT (edition_id) DO NOTHING;

    WITH moved AS (
      UPDATE public.editions SET player_id = v_keep WHERE player_id = v_drop RETURNING 1
    )
    SELECT count(*) INTO v_moved FROM moved;

    DELETE FROM public.players WHERE id = v_drop;
    RAISE NOTICE 'Curry: repointed % editions, deleted the Stephen Curry row', v_moved;
  END IF;

  INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
  VALUES (v_ts, 'stephen-curry', v_keep, 'Trevor 2026-09-25: one player, named "Steph Curry" (#137 a)')
  ON CONFLICT (collection_id, alias_slug) DO NOTHING;

  -- Post-conditions.
  SELECT count(*) INTO v_n FROM public.players
   WHERE collection_id = v_ts AND name ~* '^steph(en)? curry$';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected one Curry players row, found %', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.editions
   WHERE collection_id = v_ts AND player_name ~* '^steph(en)? curry$' AND player_id IS DISTINCT FROM v_keep;
  IF v_n <> 0 THEN RAISE EXCEPTION '% Curry editions are not on the Steph Curry row', v_n; END IF;

  -- Positive control: both spellings now resolve to the one row and mint nothing.
  IF public.resolve_canonical_player(v_ts, 'Stephen Curry') IS DISTINCT FROM v_keep
     OR public.resolve_canonical_player(v_ts, 'Steph Curry') IS DISTINCT FROM v_keep THEN
    RAISE EXCEPTION 'resolve_canonical_player does not resolve both Curry spellings to the kept row';
  END IF;
  IF public.get_player_alias_target(v_ts, 'stephen-curry') IS DISTINCT FROM 'steph-curry' THEN
    RAISE EXCEPTION 'get_player_alias_target(stephen-curry) is not steph-curry';
  END IF;
  -- No-change control: an unaliased name still resolves by slug.
  IF public.resolve_canonical_player(v_ts, 'LeBron James') IS NULL THEN
    RAISE EXCEPTION 'resolver lost the ordinary slug path';
  END IF;
  SELECT count(*) INTO v_n FROM public.players
   WHERE collection_id = v_ts AND name ~* '^steph(en)? curry$';
  IF v_n <> 1 THEN RAISE EXCEPTION 'a control call minted a Curry row (% now)', v_n; END IF;
END $$;
