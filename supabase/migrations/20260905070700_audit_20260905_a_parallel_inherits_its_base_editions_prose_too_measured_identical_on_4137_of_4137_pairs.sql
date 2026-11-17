-- audit_20260905_a_parallel_inherits_its_base_editions_prose_too_measured_identical_on_4137_of_4137_pairs
--
-- anon-exec: public.sync_topshot_parallel_identity_from_base(integer) keeps its existing ACL
-- (postgres, service_role only). Same signature, so no new overload is created and
-- CREATE OR REPLACE does not reset an ACL -- nothing about who may EXECUTE it changes.
--
-- WHAT AND WHY. `editions.description` is the narrative-search prose. The Atlas enrichment
-- (`20260905024630`) took Top Shot coverage from a frozen 68.5% to ~95%, and the residual was
-- measured rather than assumed: **663 NULL descriptions, every one of them in a set the Atlas
-- walk has COMPLETED since the enrichment shipped** -- so the walk is not behind, Atlas simply
-- has no `Description` for those rows. 100 of them are editions Atlas does not carry at all
-- (the `Club Collection` class, see docs/reference/database.md), which can never be filled
-- from this source.
--
-- ⭐ But 160 of them are PARALLELS whose BASE edition does have the prose, and that is fillable
-- without inventing anything, because the description describes the PLAY and a parallel is the
-- same play in a different printing.
--
-- ⭐ THE POSITIVE CONTROL, and it is total: of the **4,137** base/parallel pairs where BOTH
-- rows already carry a description, **4,137 are byte-identical and ZERO differ.** Atlas serves
-- the same text for a printing as for its base. So this fill reproduces exactly what the
-- upstream would serve, and it is a copy rather than a guess.
--
-- WHERE IT LIVES, and why here rather than in the Atlas drain. This function already exists to
-- make a parallel inherit its base edition's identity (name, player, team), already runs hourly
-- on pg_cron, is already FILL-ONLY and already audited. Prose is the same relationship. Putting
-- it in the shared `atlas_editions_drain` page loop instead would add a self-join to the lane
-- that feeds badges for the whole catalogue, for a 160-row tail.
--
-- ⚠ THE ORIGINAL PREDICATE IS PRESERVED EXACTLY, not relaxed. The identity arm still requires
-- `COALESCE(b.player_name,'') <> ''`; the prose arm is OR-ed alongside it, so a row that
-- qualifies only for prose cannot pull identity it was previously refused. The redundant
-- team-agreement check still applies to every candidate. Fill-only in both arms: a parallel
-- that already has a description is never rewritten.
--
-- REVERT: restore the prior body (it is unchanged apart from the description arm) and
--   UPDATE public.editions e SET description = NULL
--     FROM public.audit_20260904_parallel_identity a
--    WHERE e.id = a.edition_id AND a.old_description IS NULL AND a.description_filled_at IS NOT NULL;
ALTER TABLE public.audit_20260904_parallel_identity
  ADD COLUMN IF NOT EXISTS old_description text,
  ADD COLUMN IF NOT EXISTS description_filled_at timestamptz;

CREATE OR REPLACE FUNCTION public.sync_topshot_parallel_identity_from_base(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_n integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('sync_topshot_parallel_identity_from_base')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  WITH cand AS (
    SELECT e.id, e.external_id,
           e.name AS old_name, e.player_name AS old_player, e.team_name AS old_team,
           e.description AS old_description,
           CASE WHEN e.name IS NULL OR e.name LIKE 'Unknown%' THEN b.name ELSE e.name END AS new_name,
           CASE WHEN COALESCE(e.player_name, '') = '' THEN b.player_name ELSE e.player_name END AS new_player,
           CASE WHEN COALESCE(e.team_name, '')   = '' THEN b.team_name   ELSE e.team_name   END AS new_team,
           -- Prose describes the PLAY, and a parallel is the same play in another printing.
           -- Measured 2026-09-05: 4,137 of 4,137 pairs that both carry prose are IDENTICAL.
           CASE WHEN e.description IS NULL THEN b.description ELSE e.description END AS new_description
      FROM public.editions e
      JOIN public.editions b
        ON b.collection_id = e.collection_id
       AND b.external_id   = split_part(e.external_id, '::', 1)
     WHERE e.collection_id = v_ts
       AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
       -- only ever FILL: the parallel must be missing what the base has
       AND (
             -- identity arm -- UNCHANGED from the original, including its b.player_name guard
             ( (COALESCE(e.player_name, '') = '' OR COALESCE(e.team_name, '') = '' OR e.name LIKE 'Unknown%')
               AND COALESCE(b.player_name, '') <> '' )
             -- prose arm -- new, and cannot pull identity the row was previously refused
          OR ( e.description IS NULL AND b.description IS NOT NULL )
           )
       -- redundant agreement check on top of the key relationship: if both name a team, it matches
       AND (COALESCE(e.team_name, '') = '' OR COALESCE(b.team_name, '') = '' OR e.team_name = b.team_name)
     LIMIT GREATEST(p_limit, 1)
  ),
  changed AS (
    SELECT * FROM cand
     WHERE new_name        IS DISTINCT FROM old_name
        OR new_player      IS DISTINCT FROM old_player
        OR new_team        IS DISTINCT FROM old_team
        OR new_description IS DISTINCT FROM old_description
  ),
  logged AS (
    INSERT INTO public.audit_20260904_parallel_identity
      (edition_id, external_id, old_name, old_player_name, old_team_name, old_description, description_filled_at)
    SELECT id, external_id, old_name, old_player, old_team, old_description,
           CASE WHEN old_description IS NULL AND new_description IS NOT NULL THEN now() END
      FROM changed
    ON CONFLICT (edition_id) DO NOTHING
  ),
  upd AS (
    UPDATE public.editions e
       SET name        = c.new_name,
           player_name = c.new_player,
           team_name   = c.new_team,
           description = c.new_description
      FROM changed c
     WHERE e.id = c.id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM upd;

  IF v_n > 0 THEN
    PERFORM public.log_pipeline_run('topshot-parallel-identity-sync', v_started, v_n, v_n, 0, true, NULL,
              'nba_top_shot', NULL, NULL,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                 'filled', v_n, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('filled', v_n);
END
$function$;
