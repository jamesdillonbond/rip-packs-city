-- audit_20261107_alias_watch_flags_identity_linked_to_wrong_person
--
-- 2026-11-07 ~9:30 PM PT (Claude Code cloud). Adds a fourth arm to
-- check_player_alias_integrity() (20261108020250): WRONG PERSON — an NFL
-- player_identities link whose career (rookie_season..last_season) cannot hold the
-- player's own games, with a season of slack for January playoffs and no claim
-- before 1974 (nflverse's first season). This is how 20261108052909 found five
-- All Day players linked to a father or a namesake; after that fix the count is 0.
-- Top Shot legends are excluded on purpose: their NBA rows carry late-career
-- seasons only (Bill Walton 1986–87 on a 1977 card), which would keep this red.
--
-- Re-read live before writing: md5(prosrc) 9f03fc7a… = 20261108020250's body.
-- POSITIVE CONTROL (live, rolled back): Pat Surtain II re-linked to his father's
-- crosswalk row → wrong_person 1, sample "Patrick Surtain 1998-2008 / Pat Surtain II".
--
-- anon-exec: unchanged (check_player_alias_integrity) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (revoked).
--
-- REVERT: re-apply the function from 20261108020250.

CREATE OR REPLACE FUNCTION public.check_player_alias_integrity()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_twins    int := 0;
  v_reverted int := 0;
  v_dangling int := 0;
  v_wrong    int := 0;
  v_sample   jsonb;
  v_err      text;
BEGIN
  PERFORM set_config('statement_timeout', '30000', true);

  BEGIN
    -- TWIN: another player in the same collection is NAMED a registered alias of
    -- this one — a writer re-minted the old spelling as a second person.
    SELECT count(*) INTO v_twins
      FROM public.player_name_aliases a
      JOIN public.players p
        ON p.collection_id = a.collection_id AND p.id <> a.player_id
       AND btrim(regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g'), '-') = btrim(a.alias_slug, '-');

    -- REVERTED: the player's own name is (exactly) one of its aliases — a writer
    -- put the old spelling back over the catalog name. Exact slugs, so an alias
    -- that differs only by punctuation ("Jr" vs "Jr.") is not a revert.
    SELECT count(*) INTO v_reverted
      FROM public.player_name_aliases a
      JOIN public.players p ON p.id = a.player_id
     WHERE regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = a.alias_slug;

    -- DANGLING: the alias names no player in its collection (deleted or moved).
    SELECT count(*) INTO v_dangling
      FROM public.player_name_aliases a
      LEFT JOIN public.players p ON p.id = a.player_id AND p.collection_id = a.collection_id
     WHERE p.id IS NULL;

    -- WRONG PERSON (2026-11-07): an NFL crosswalk row whose career cannot hold the
    -- player's own games — a father linked to his son (Patrick Surtain II → the
    -- 1998–2008 CB), a namesake (Marvin Jones Jr. the 2021 WR → a 2026 rookie LB).
    -- nflverse seasons start in 1974, so an earlier game proves nothing; one season
    -- of slack covers January playoff games.
    SELECT count(*) INTO v_wrong FROM (
      SELECT i.id
        FROM public.player_identities i
        JOIN public.editions e ON e.player_id = i.player_id AND e.game_date IS NOT NULL
       WHERE i.league = 'nfl' AND i.rookie_season IS NOT NULL AND i.last_season IS NOT NULL
       GROUP BY i.id, i.rookie_season, i.last_season
      HAVING max(extract(year FROM e.game_date)) > i.last_season + 1
          OR (min(extract(year FROM e.game_date)) < i.rookie_season - 1 AND i.rookie_season > 1974)) w;

    IF v_twins + v_reverted + v_dangling + v_wrong > 0 THEN
      SELECT jsonb_agg(x) INTO v_sample FROM (
        SELECT 'twin' AS kind, a.collection_id, a.alias_slug, p.name AS other_player
          FROM public.player_name_aliases a
          JOIN public.players p
            ON p.collection_id = a.collection_id AND p.id <> a.player_id
           AND btrim(regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g'), '-') = btrim(a.alias_slug, '-')
        UNION ALL
        SELECT 'reverted', a.collection_id, a.alias_slug, p.name
          FROM public.player_name_aliases a
          JOIN public.players p ON p.id = a.player_id
         WHERE regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = a.alias_slug
        UNION ALL
        SELECT 'dangling', a.collection_id, a.alias_slug, NULL
          FROM public.player_name_aliases a
          LEFT JOIN public.players p ON p.id = a.player_id AND p.collection_id = a.collection_id
         WHERE p.id IS NULL
        UNION ALL
        SELECT 'wrong_person', i.collection_id, i.display_name || ' ' || i.rookie_season || '-' || i.last_season, max(p.name)
          FROM public.player_identities i
          JOIN public.players p ON p.id = i.player_id
          JOIN public.editions e ON e.player_id = i.player_id AND e.game_date IS NOT NULL
         WHERE i.league = 'nfl' AND i.rookie_season IS NOT NULL AND i.last_season IS NOT NULL
         GROUP BY i.id, i.collection_id, i.display_name, i.rookie_season, i.last_season
        HAVING max(extract(year FROM e.game_date)) > i.last_season + 1
            OR (min(extract(year FROM e.game_date)) < i.rookie_season - 1 AND i.rookie_season > 1974)
        LIMIT 10) x;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- ok = FALSE on any violation (or a failed read), so get_pipeline_alerts'
  -- failure_rate arm reports it with no edit there (pattern of check_topshot_dupe_sales).
  PERFORM public.log_pipeline_run(
    'player-alias-integrity-watch', v_started, v_twins + v_reverted + v_dangling + v_wrong, 0, 0,
    (v_err IS NULL AND v_twins + v_reverted + v_dangling + v_wrong = 0),
    COALESCE(v_err, CASE WHEN v_twins + v_reverted + v_dangling + v_wrong > 0
      THEN v_twins || ' twin(s), ' || v_reverted || ' reverted name(s), ' || v_dangling
           || ' dangling alias(es), ' || v_wrong
           || ' identity link(s) to the wrong person — see extra.sample'
      END),
    NULL, NULL, NULL,
    jsonb_build_object('twins', v_twins, 'reverted', v_reverted, 'dangling', v_dangling,
                       'wrong_person', v_wrong, 'sample', v_sample, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('twins', v_twins, 'reverted', v_reverted, 'dangling', v_dangling,
                            'wrong_person', v_wrong, 'sample', v_sample, 'error', v_err);
END
$function$;
