-- audit_20261108_wmc_player_names_follow_the_linked_person
--
-- #221, second pass (2026-11-08, Claude Code, Trevor's Windows box; Trevor: "address these and try
-- to fix them"). The morning heal (20261108171307) rewrote wmc.player_name to the edition's TEXT
-- (editions.player_name) where the cached spelling was a registered alias or a case/space variant —
-- 10,583 rows. What remained (4,467 rows vs editions, 22,673 vs the person) measured:
--   * every remaining edition is LINKED (editions.player_id) — the PERSON, by
--     docs/reference/player-identity.md: "editions.player_name is the league's LABEL;
--     editions.player_id is the PERSON (2026-10-20)";
--   * 3,245 rows: wmc already equals the linked person and the edition LABEL is the odd one
--     (Top Shot "Jimmy Butler" / person "Jimmy Butler III"; All Day legal names "Andrew McConkey"
--     / "Ladd McConkey") — so the morning's target, the label, was the wrong authority;
--   * 1,222 rows: the label equals the person and wmc lags by an accent ("Aleksej Pokuševski" vs
--     the person row "Aleksej Pokusevski") — the person row is the decision #221 asked for;
--   * 21,451 rows: wmc and the label agree with each other but not with the person (Top Shot
--     "Jimmy Butler" ×4,366, All Day "Patrick Mahomes II" ×1,132 vs person "Patrick Mahomes") —
--     one person showing two names, against Trevor's 11-07 rule (one person, ONE name).
--
-- WHAT. heal_wmc_player_names_from_catalog now sets wmc.player_name to the LINKED PERSON's name
-- (players.name via editions.player_id, same collection) wherever it differs. A Team Moment
-- (player_id NULL) and Pinnacle are never touched; a link into another collection is ignored.
-- Same signature, schedule (pg_cron 834, 3:29 AM PT) and run log; the return carries `rewrites`
-- (alias_rewrites / case_space_rewrites retired — the person is the one rule now).
-- Edition LABELS are not renamed here: that is the per-person rename runbook (read the league
-- heading first). No alias rows are added: the 12 label spellings without one are All Day
-- team-moment city labels ("Buffalo" → "Buffalo Bills"), which must not become player aliases;
-- the 6 that would TWIN another person (Josh Allen / Hines-Allen, Marvin Harrison / Jr., Joey
-- Porter / Jr., the two Luis Suárez) are the namesakes the identity rules protect.
--
-- PIN: supabase/tests/heal_wmc_player_names_from_catalog.sql (re-written for the person rule).
-- anon-exec: unchanged (heal_wmc_player_names_from_catalog) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (service_role only).
-- REVERT: re-apply the body from 20261108171307_audit_20261108_wmc_player_names_follow_the_catalog.sql
--         (rows already rewritten keep the person's name — the spelling every hub already shows).

CREATE OR REPLACE FUNCTION public.heal_wmc_player_names_from_catalog(p_limit integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_pin     constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_n       int := 0;
BEGIN
  WITH cand AS (
    SELECT w.id, p.name AS person_name
      FROM public.wallet_moments_cache w
      JOIN public.editions e
        ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
      JOIN public.players p
        ON p.id = e.player_id AND p.collection_id = w.collection_id
     WHERE w.collection_id <> v_pin
       AND p.name IS NOT NULL AND btrim(p.name) <> ''
       AND w.player_name IS DISTINCT FROM p.name
     LIMIT greatest(coalesce(p_limit, 50000), 0)
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET player_name = c.person_name
      FROM cand c
     WHERE w.id = c.id
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;

  -- rows_written = rows actually updated (RETURNING), never the candidate count.
  PERFORM public.log_pipeline_run(
    'wmc-player-names-follow-catalog', v_started,
    v_n, v_n, 0,
    true, NULL, NULL, NULL, NULL,
    jsonb_build_object('rewrites', v_n, 'target', 'linked_person', 'limit', p_limit));

  RETURN jsonb_build_object('ok', true, 'rewrites', v_n);
END
$function$;
