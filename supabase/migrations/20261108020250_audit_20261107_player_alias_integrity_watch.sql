-- audit_20261107_player_alias_integrity_watch
--
-- 2026-11-07 ~6:05 PM PT (Claude Code cloud). Trevor, 5:58 PM: "make sure
-- we're setup for long term success on these" (today's player renames).
--
-- WHY. Today's renames keep each old spelling as a row in player_name_aliases.
-- Three writers can undo that silently: one that mints the old spelling as a
-- NEW player (a twin — the hub, search and the concierge then split one person
-- in two), one that writes the old spelling back over players.name (reverted),
-- and one that deletes or moves the player an alias points at (dangling). None
-- of them errors; each looks like normal ingest.
--
-- WHAT. check_player_alias_integrity() counts all three, logs a
-- 'player-alias-integrity-watch' run with ok = (nothing found), and pg_cron runs
-- it 4×/day (:41 at 2/8/14/20 UTC). A non-ok run reaches get_pipeline_alerts'
-- failure_rate arm (≥5 runs in 3 days, >25 % failed) with no edit there — the
-- pattern of check_topshot_dupe_sales. Baseline at apply: 0 / 0 / 0.
-- Positive control (live, rolled back): a Panini player named "Stephen Curry"
-- plus Enes Freedom renamed back to "Enes Kanter" → twins 1, reverted 1, both
-- in extra.sample. "Reverted" compares EXACT slugs so a punctuation-only alias
-- ("Khalil Rountree Jr" for "Khalil Rountree Jr.") is not a revert.
--
-- anon-exec: revoked (check_player_alias_integrity) — maintenance, writes pipeline_runs; pg_cron/postgres only (job runs as postgres, the owner).
--
-- REVERT: SELECT cron.unschedule('rpc-player-alias-integrity-watch');
--         DROP FUNCTION public.check_player_alias_integrity();

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

    IF v_twins + v_reverted + v_dangling > 0 THEN
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
        LIMIT 10) x;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- ok = FALSE on any violation (or a failed read), so get_pipeline_alerts'
  -- failure_rate arm reports it with no edit there (pattern of check_topshot_dupe_sales).
  PERFORM public.log_pipeline_run(
    'player-alias-integrity-watch', v_started, v_twins + v_reverted + v_dangling, 0, 0,
    (v_err IS NULL AND v_twins + v_reverted + v_dangling = 0),
    COALESCE(v_err, CASE WHEN v_twins + v_reverted + v_dangling > 0
      THEN v_twins || ' twin(s), ' || v_reverted || ' reverted name(s), ' || v_dangling
           || ' dangling alias(es) — a writer re-minted or restored an old player spelling; see extra.sample'
      END),
    NULL, NULL, NULL,
    jsonb_build_object('twins', v_twins, 'reverted', v_reverted, 'dangling', v_dangling,
                       'sample', v_sample, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('twins', v_twins, 'reverted', v_reverted, 'dangling', v_dangling,
                            'sample', v_sample, 'error', v_err);
END
$function$;

REVOKE ALL ON FUNCTION public.check_player_alias_integrity() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('rpc-player-alias-integrity-watch', '41 2,8,14,20 * * *',
                     $cron$ SELECT public.check_player_alias_integrity() $cron$);
