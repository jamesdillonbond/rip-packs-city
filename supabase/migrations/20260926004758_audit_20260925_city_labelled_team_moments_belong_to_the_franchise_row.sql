-- 2026-09-25 (PT) — team moments labelled by their CITY are the franchise's,
-- not a person's: All Day's 2025 "Banner Year" set labels each team moment
-- with the city ("Buffalo" on a Buffalo Bills edition, "Los Angeles" on BOTH
-- a Rams and a Chargers edition), and ensure_players_from_edition_names —
-- which skips a label equal to the team name or "Team Moment" — minted 13
-- "players" named Buffalo, Carolina, Los Angeles… (one of them holding two
-- franchises' moments). They surfaced as the last unkeyed All Day rows after
-- batch 51.
--
-- (1) the 14 editions move to the franchise-named players rows that already
--     hold each team's moments ("Buffalo Bills", the row every other Bills
--     team moment links to), the 13 city rows are deleted (backups in the
--     batch-44 audit tables; no aliases — a city is not a person).
-- (2) ensure_players_from_edition_names: a label that is the CITY PREFIX of
--     the edition's team_name is never minted (one predicate spliced into the
--     live body, md5 139fee3e…, anchor asserted once).
-- (3) link_editions_to_players_by_name: a third legacy arm links such an
--     edition to the one players row named after its team. Full-body write
--     from the live prosrc (md5 6de3daaf… == the 20260925232127 file); pinned.
--
-- Revert: players/editions from the audit tables (rows stamped now());
-- re-apply the linker from 20260925232127; remove the ensure predicate.

DO $$
DECLARE r RECORD; v_franchise uuid; v_n int; v_coll uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  FOR r IN
    SELECT p.id AS city_id, p.name AS city, e.id AS edition_id, e.team_name
      FROM public.editions e JOIN public.players p ON p.id = e.player_id
     WHERE p.collection_id = v_coll
       AND e.team_name LIKE p.name || ' %'
       AND NOT EXISTS (SELECT 1 FROM public.teams_master t WHERE t.team_name = p.name)
  LOOP
    SELECT count(*) INTO v_n FROM public.players f WHERE f.collection_id = v_coll AND f.name = r.team_name;
    IF v_n <> 1 THEN RAISE EXCEPTION 'batch 54: % franchise rows named "%"', v_n, r.team_name; END IF;
    SELECT f.id INTO v_franchise FROM public.players f WHERE f.collection_id = v_coll AND f.name = r.team_name;
    INSERT INTO public.audit_20260925_suffix_editions_backup (edition_id, player_id)
      VALUES (r.edition_id, r.city_id) ON CONFLICT (edition_id) DO NOTHING;
    UPDATE public.editions SET player_id = v_franchise WHERE id = r.edition_id;
  END LOOP;
  -- the city rows, now empty, go
  FOR r IN
    SELECT p.id, p.name FROM public.players p
     WHERE p.collection_id = v_coll
       AND NOT EXISTS (SELECT 1 FROM public.editions e WHERE e.player_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.teams_master t WHERE t.team_name = p.name)
       AND p.name IN ('Buffalo','Carolina','Chicago','Denver','Green Bay','Houston','Jacksonville','Los Angeles',
                      'New England','Philadelphia','Pittsburgh','San Francisco','Seattle')
  LOOP
    IF EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = r.id)
       OR EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.player_id = r.id) THEN
      RAISE EXCEPTION 'batch 54: city row "%" is referenced', r.name;
    END IF;
    INSERT INTO public.audit_20260925_suffix_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = r.id;
    DELETE FROM public.players WHERE id = r.id;
  END LOOP;
END $$;

-- (2)
DO $$
DECLARE
  v_src    text;
  v_anchor text := E'       AND lower(trim(e.player_name)) <> ''team moment''\n';
  v_add    text := E'       -- 2026-09-25 (batch 54): nor a team moment labelled by its CITY ("Buffalo"\n'
                || E'       -- on a Buffalo Bills edition) — the linker puts it on the franchise row\n'
                || E'       AND NOT (e.team_name IS NOT NULL AND e.team_name LIKE trim(e.player_name) || '' %'')\n';
  v_n      int;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ensure_players_from_edition_names';
  IF v_src IS NULL THEN RAISE EXCEPTION 'ensure_players_from_edition_names: not found'; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ensure_players_from_edition_names: anchor found % times, want 1', v_n; END IF;
  IF position('labelled by its CITY' IN v_src) > 0 THEN RAISE EXCEPTION 'ensure_players_from_edition_names: already spliced'; END IF;
  v_src := replace(v_src, v_anchor, v_anchor || v_add);
  -- anon-exec: intentional — spliced re-create of ensure_players_from_edition_names; ACL unchanged
  EXECUTE 'CREATE OR REPLACE FUNCTION public.ensure_players_from_edition_names(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 5000)'
       || ' RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'', ''pg_temp'' AS '
       || quote_literal(v_src);
END $$;

-- (3)
-- anon-exec: intentional — full-body write of link_editions_to_players_by_name
-- (the pg_cron 612 job); its ACL is unchanged by CREATE OR REPLACE
CREATE OR REPLACE FUNCTION public.link_editions_to_players_by_name(p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_linked  int := 0;
  v_ident   int := 0;
  v_minted  int := 0;
  v_amb     int := 0;
  v_blocked int := 0;
  v_legacy  int := 0;
  v_ok      boolean := true;
  v_err     text;
BEGIN
  BEGIN
    WITH unl AS (
      SELECT e.id AS edition_id, e.collection_id, e.player_name, e.team_name, e.game_date
      FROM public.editions e
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND e.player_name IS DISTINCT FROM e.team_name
        AND lower(btrim(e.player_name)) <> 'team moment'
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
    ),
    -- 2026-09-25: the identity arm. The league-id crosswalk decides by base
    -- name + game year + team; 'one' links (minting the league's spelling
    -- when RPC has no row), 'ambiguous' is counted and left, 'none' falls
    -- to the name/alias arms below.
    res AS (
      SELECT u.*,
             r->>'verdict'              AS verdict,
             (r->>'identity_id')::uuid  AS identity_id,
             (r->>'player_id')::uuid    AS ident_player_id,
             r->>'display_name'         AS display_name,
             r->>'name_slug'            AS name_slug,
             regexp_replace(lower(trim(extensions.unaccent(u.player_name))), '[^a-z0-9]+', '-', 'g') AS label_slug
      FROM unl u
      CROSS JOIN LATERAL public.resolve_player_identity(u.collection_id, u.player_name, u.team_name, u.game_date) r
    ),
    to_mint AS (
      SELECT DISTINCT ON (r.identity_id) r.identity_id, r.collection_id, r.display_name, r.name_slug, r.team_name, c.slug AS coll_slug
      FROM res r JOIN public.collections c ON c.id = r.collection_id
      WHERE r.verdict = 'one' AND r.ident_player_id IS NULL
        -- a row already keyed by that slug belongs to someone else: do not
        -- steal it, leave the edition unlinked and count it (mint_blocked)
        AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.external_id = c.slug || '-' || r.name_slug)
      ORDER BY r.identity_id, r.game_date DESC NULLS LAST
    ),
    minted AS (
      INSERT INTO public.players (external_id, collection_id, name, team, collection)
      SELECT m.coll_slug || '-' || m.name_slug, m.collection_id, m.display_name, m.team_name, m.coll_slug
      FROM to_mint m
      ON CONFLICT (external_id) DO NOTHING
      RETURNING id, external_id
    ),
    linked_ident AS (
      UPDATE public.player_identities i
         SET player_id = m.id, matched_by = 'linker', matched_at = now()
        FROM to_mint t
        JOIN minted m ON m.external_id = t.coll_slug || '-' || t.name_slug
       WHERE i.id = t.identity_id AND i.player_id IS NULL
       RETURNING i.id AS identity_id, i.player_id
    ),
    ident_target AS (
      SELECT r.edition_id, r.collection_id, r.label_slug, r.name_slug,
             COALESCE(r.ident_player_id, li.player_id) AS player_id
      FROM res r
      LEFT JOIN linked_ident li ON li.identity_id = r.identity_id
      WHERE r.verdict = 'one'
    ),
    -- the label's own slug becomes an alias of the league-spelt row, only when
    -- no players row carries that slug (an existing row keeps its URL)
    aliased AS (
      INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
      SELECT DISTINCT ON (t.collection_id, t.label_slug) t.collection_id, t.label_slug, t.player_id,
             'linker ' || to_char(now(), 'YYYY-MM-DD') || ': edition label for ' || t.name_slug
      FROM ident_target t
      WHERE t.player_id IS NOT NULL AND t.label_slug <> t.name_slug
        AND NOT EXISTS (SELECT 1 FROM public.players p
                         WHERE p.collection_id = t.collection_id
                           AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = t.label_slug)
      ORDER BY t.collection_id, t.label_slug, t.player_id
      ON CONFLICT (collection_id, alias_slug) DO NOTHING
      RETURNING 1
    ),
    upd_ident AS (
      UPDATE public.editions e
         SET player_id = t.player_id
        FROM ident_target t
       WHERE e.id = t.edition_id AND e.player_id IS NULL AND t.player_id IS NOT NULL
      RETURNING e.id, e.player_id
    ),
    cand AS (
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
        AND NOT EXISTS (SELECT 1 FROM res r WHERE r.edition_id = e.id AND r.verdict <> 'none')
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
        AND NOT EXISTS (SELECT 1 FROM res r WHERE r.edition_id = e.id AND r.verdict <> 'none')
        AND NOT EXISTS (SELECT 1 FROM public.players p2
                         WHERE p2.collection_id = e.collection_id
                           AND lower(extensions.unaccent(btrim(p2.name))) = lower(extensions.unaccent(btrim(e.player_name))))
      UNION ALL
      -- 2026-09-25 (batch 54): a team moment labelled by its CITY ("Buffalo" on
      -- a Buffalo Bills "Banner Year" edition) links to the franchise row named
      -- after the team — never to a person, never to a row minted for the city
      SELECT e.id AS edition_id, f.id AS player_id
      FROM public.editions e
      JOIN public.players f
        ON f.collection_id = e.collection_id
       AND f.name = e.team_name
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND e.team_name IS NOT NULL
        AND e.team_name LIKE btrim(e.player_name) || ' %'
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
        AND NOT EXISTS (SELECT 1 FROM res r WHERE r.edition_id = e.id AND r.verdict <> 'none')
        AND NOT EXISTS (SELECT 1 FROM public.players p2
                         WHERE p2.collection_id = e.collection_id
                           AND lower(extensions.unaccent(btrim(p2.name))) = lower(extensions.unaccent(btrim(e.player_name))))
        AND (SELECT count(*) FROM public.players f2
              WHERE f2.collection_id = e.collection_id AND f2.name = e.team_name) = 1
    ),
    upd AS (
      UPDATE public.editions e
         SET player_id = c.player_id
        FROM cand c
       WHERE e.id = c.edition_id AND e.player_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM upd_ident ui WHERE ui.id = e.id)
      RETURNING e.id, e.player_id
    ),
    bk AS (
      INSERT INTO public.audit_20260925_edition_player_link_backup (edition_id, player_id)
      SELECT id, player_id FROM upd
      UNION ALL
      SELECT id, player_id FROM upd_ident
      ON CONFLICT (edition_id) DO NOTHING
    )
    SELECT (SELECT count(*)::int FROM upd),
           (SELECT count(*)::int FROM upd_ident),
           (SELECT count(*)::int FROM minted),
           (SELECT count(*)::int FROM res WHERE verdict = 'ambiguous'),
           (SELECT count(*)::int FROM ident_target WHERE player_id IS NULL)
      INTO v_legacy, v_ident, v_minted, v_amb, v_blocked;
    v_linked := v_legacy + v_ident;
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
                       'by_identity', v_ident, 'players_minted', v_minted, 'identity_ambiguous', v_amb, 'mint_blocked', v_blocked,
                       'by_name_or_alias', v_legacy,
                       'elapsed_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000))
  );
  IF NOT v_ok THEN
    RAISE EXCEPTION 'link_editions_to_players_by_name: %', v_err;
  END IF;
  RETURN v_linked;
END;
$function$;

-- Post-conditions
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.players
   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND name IN ('Buffalo','Carolina','Chicago','Denver','Green Bay','Houston','Jacksonville','Los Angeles',
                  'New England','Philadelphia','Pittsburgh','San Francisco','Seattle');
  IF v_n <> 0 THEN RAISE EXCEPTION 'batch 54: % city rows remain', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.editions e JOIN public.players p ON p.id = e.player_id
   WHERE p.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND e.set_name = 'Banner Year' AND p.name <> e.team_name;
  IF v_n <> 0 THEN RAISE EXCEPTION 'batch 54: % Banner Year editions not on their franchise row', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc WHERE proname = 'ensure_players_from_edition_names' AND prosrc LIKE '%labelled by its CITY%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'batch 54: ensure splice missing'; END IF;
END $$;
