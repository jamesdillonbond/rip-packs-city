-- 2026-09-25 (PT) — 3,496 Top Shot editions (24% of 14,460) carried a
-- player_name but no player_id: the catalog writers name the player and never
-- resolve the row, and no function in the estate sets editions.player_id
-- (grep of pg_proc: none), so the link only ever came from the wallet-search
-- writer. get_player_detail / get_player_editions tolerate it (`e.player_id =
-- p.id OR e.player_name = p.name`), which is why nothing looked broken — but
-- every join that keys on player_id (badges, pooled serial effects, the 09-24
-- team-moment audit) silently misses a quarter of the catalog.
--
-- 3,485 of them match exactly one players row by EXACT name within the
-- collection (0 ambiguous — the 12 same-name duplicates were merged 09-24,
-- 20260925063021); 3 match only by slug and 8 have no player row — those stay
-- NULL for ensure_players_from_edition_names (daily 9:50 UTC) to seed first.
--
-- Two parts: (1) link_editions_to_players_by_name(p_collection_id) — exact
-- name, unambiguous only, never fuzzy; logged as pipeline 'editions-player-link'
-- with rows WRITTEN; (2) the one-time run for every collection, with the touched
-- edition ids in audit_20260925_edition_player_link_backup (RLS on), and a daily
-- pg_cron tick at 9:55 UTC, five minutes after the player seeder.
-- Revert: UPDATE editions e SET player_id = NULL FROM
-- audit_20260925_edition_player_link_backup b WHERE b.edition_id = e.id;
-- cron.unschedule('rpc-link-editions-to-players'); DROP FUNCTION.

CREATE TABLE IF NOT EXISTS public.audit_20260925_edition_player_link_backup (
  edition_id  uuid PRIMARY KEY,
  player_id   uuid NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260925_edition_player_link_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_edition_player_link_backup FROM PUBLIC, anon, authenticated;

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
        ON p.collection_id = e.collection_id AND p.name = e.player_name
      WHERE e.player_id IS NULL
        AND e.player_name IS NOT NULL
        AND btrim(e.player_name) <> ''
        AND e.player_name IS DISTINCT FROM e.team_name
        AND lower(btrim(e.player_name)) <> 'team moment'
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
        -- exactly one players row of that name in that collection
        AND (SELECT count(*) FROM public.players p2
              WHERE p2.collection_id = e.collection_id AND p2.name = e.player_name) = 1
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

-- One-time run now (every collection), then daily after the seeder.
SELECT public.link_editions_to_players_by_name(NULL);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-link-editions-to-players') THEN
    PERFORM cron.schedule('rpc-link-editions-to-players', '55 9 * * *',
      'SELECT public.link_editions_to_players_by_name(NULL)');
  END IF;
END $$;

-- Post-conditions: the unlinked-with-a-matching-row population is now 0.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM public.editions e
  WHERE e.player_id IS NULL AND e.player_name IS NOT NULL
    AND e.player_name IS DISTINCT FROM e.team_name
    AND (SELECT count(*) FROM public.players p WHERE p.collection_id = e.collection_id AND p.name = e.player_name) = 1;
  IF n <> 0 THEN RAISE EXCEPTION '% editions still unlinked despite an unambiguous player row', n; END IF;
  IF (SELECT count(*) FROM public.audit_20260925_edition_player_link_backup) < 3000 THEN
    RAISE EXCEPTION 'expected ~3,485 links, backup holds %', (SELECT count(*) FROM public.audit_20260925_edition_player_link_backup);
  END IF;
END $$;
