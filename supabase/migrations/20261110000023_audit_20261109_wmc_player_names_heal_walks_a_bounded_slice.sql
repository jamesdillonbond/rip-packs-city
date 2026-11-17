-- audit_20261109_wmc_player_names_heal_walks_a_bounded_slice
--
-- #221 heal, third pass (2026-11-09, Claude Code cloud; Trevor: "Do everything, leave nothing
-- unresolved from this thread"). Daytime-monitor filing 2026-11-09T2211Z.
--
-- WHY. heal_wmc_player_names_from_catalog (pg_cron 834, daily 2:29 AM PT) failed with a statement
-- timeout on 11-09. Measured 3:20 PM PT: its candidate CTE joins EVERY non-Pinnacle
-- wallet_moments_cache row to editions → players and reads player_name from the heap; the Candy
-- census added ~1.4M rows (table 3.61M), the Candy slice alone exceeds 55 s, and with few real
-- candidates the LIMIT never short-circuits — the cost is the whole table, every run. Planner stats
-- were NOT the cause (autoanalyze 2:59 PM PT, 97 % all-visible). Candy cannot be skipped: 43 Candy
-- editions carry a label that differs from the linked person.
--
-- WHAT. Same function, same signature, same rule (wmc.player_name := the LINKED PERSON's name,
-- players.name via editions.player_id, same collection; Team Moments, Pinnacle and cross-collection
-- links never touched; rows_written = rows actually updated). What changes is HOW MUCH one call
-- reads: it walks editions-with-a-person in (external_id, collection_id) order — the order of the
-- existing unique index editions_external_id_collection_id_key — behind a cursor in
-- wmc_player_name_heal_cursor, taking keys until ~20,000 wmc rows (counted index-only on
-- idx_wmc_coll_ek_serial_cover; the first key is always taken), and fixes only those keys' rows.
--   * p_limit still caps rows written per call; a capped call does NOT advance the cursor, so the
--     next call re-reads the same keys and finishes them (fixed rows are no longer candidates).
--   * past the last key the cursor resets and `passes` increments (a new pass starts next call).
-- pg_cron 834 moves from daily to every 5 min (`2-59/5`): 288 × 20k ≈ 5.8M rows/day ≥ the 3.6M
-- table, so a full pass completes inside a day. A failed cursor write fails the whole call (one
-- transaction) — the run is never logged ok with the cursor unmoved.
--
-- PIN: supabase/tests/heal_wmc_player_names_from_catalog.sql (re-written for the walk).
-- anon-exec: unchanged (heal_wmc_player_names_from_catalog) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (service_role only).
-- REVERT: re-apply the body from 20261108191632_audit_20261108_wmc_player_names_follow_the_linked_person.sql;
--         SELECT cron.alter_job(834, schedule := '29 10 * * *'); DROP TABLE public.wmc_player_name_heal_cursor;

CREATE TABLE IF NOT EXISTS public.wmc_player_name_heal_cursor (
  id         integer PRIMARY KEY CHECK (id = 1),
  last_key   text NOT NULL DEFAULT '',
  last_coll  uuid,
  passes     integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wmc_player_name_heal_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wmc_player_name_heal_cursor FROM PUBLIC, anon, authenticated;
INSERT INTO public.wmc_player_name_heal_cursor (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.heal_wmc_player_names_from_catalog(p_limit integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_pin        constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_row_budget constant integer := 20000;
  v_cap        integer := greatest(coalesce(p_limit, 50000), 0);
  v_from_key   text;
  v_from_coll  uuid;
  v_keys       text[];
  v_colls      uuid[];
  v_rows_seen  bigint;
  v_n          int := 0;
BEGIN
  SELECT last_key, last_coll INTO v_from_key, v_from_coll
    FROM public.wmc_player_name_heal_cursor WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.wmc_player_name_heal_cursor (id) VALUES (1);
    v_from_key := ''; v_from_coll := NULL;
  END IF;

  -- The next keys in (external_id, collection_id) order, taken while the running wmc row count
  -- stays under the budget. The first key is always taken, however many rows it holds.
  SELECT array_agg(k ORDER BY k, c), array_agg(c ORDER BY k, c), max(cum)
    INTO v_keys, v_colls, v_rows_seen
    FROM (
      SELECT k, c, n, sum(n) OVER (ORDER BY k, c) AS cum
        FROM (
          SELECT e.external_id::text AS k, e.collection_id AS c,
                 (SELECT count(*) FROM public.wallet_moments_cache w
                   WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id) AS n
            FROM public.editions e
            JOIN public.players p ON p.id = e.player_id AND p.collection_id = e.collection_id
           WHERE e.collection_id <> v_pin
             AND p.name IS NOT NULL AND btrim(p.name) <> ''
             AND (v_from_coll IS NULL AND e.external_id::text > v_from_key
                  OR (e.external_id::text, e.collection_id) > (v_from_key, v_from_coll))
           ORDER BY e.external_id, e.collection_id
           LIMIT 500
        ) a
    ) q
   WHERE q.cum - q.n < v_row_budget;

  IF v_keys IS NULL THEN
    -- End of a pass: start again from the top on the next call.
    UPDATE public.wmc_player_name_heal_cursor
       SET last_key = '', last_coll = NULL, passes = passes + 1, updated_at = now()
     WHERE id = 1;
    PERFORM public.log_pipeline_run(
      'wmc-player-names-follow-catalog', v_started,
      0, 0, 0,
      true, NULL, NULL, v_from_key, '',
      jsonb_build_object('rewrites', 0, 'target', 'linked_person', 'limit', p_limit, 'pass_restarted', true));
    RETURN jsonb_build_object('ok', true, 'rewrites', 0, 'pass_restarted', true);
  END IF;

  WITH k AS (
    SELECT unnest(v_keys) AS k, unnest(v_colls) AS c
  ), cand AS (
    SELECT w.id, p.name AS person_name
      FROM k
      JOIN public.editions e ON e.external_id = k.k AND e.collection_id = k.c
      JOIN public.players p ON p.id = e.player_id AND p.collection_id = e.collection_id
      JOIN public.wallet_moments_cache w ON w.collection_id = k.c AND w.edition_key = k.k
     WHERE w.player_name IS DISTINCT FROM p.name
     LIMIT v_cap
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET player_name = c.person_name
      FROM cand c
     WHERE w.id = c.id
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;

  -- A call that hit p_limit leaves the cursor where it was: the same keys are re-read next call
  -- and finished. Otherwise the cursor moves past the last key read.
  IF v_n < v_cap THEN
    UPDATE public.wmc_player_name_heal_cursor
       SET last_key = v_keys[array_length(v_keys, 1)],
           last_coll = v_colls[array_length(v_colls, 1)],
           updated_at = now()
     WHERE id = 1;
  END IF;

  -- rows_written = rows actually updated (RETURNING), never the candidate count.
  PERFORM public.log_pipeline_run(
    'wmc-player-names-follow-catalog', v_started,
    v_n, v_n, 0,
    true, NULL, NULL, v_from_key, v_keys[array_length(v_keys, 1)],
    jsonb_build_object('rewrites', v_n, 'target', 'linked_person', 'limit', p_limit,
                       'keys', array_length(v_keys, 1), 'rows_read', v_rows_seen,
                       'capped', v_n >= v_cap));

  RETURN jsonb_build_object('ok', true, 'rewrites', v_n, 'keys', array_length(v_keys, 1));
END
$function$;

SELECT cron.alter_job(834, schedule := '2-59/5 * * * *');
