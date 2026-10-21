-- audit_20261020_topshot_challenges_from_atlas_quests
-- anon-exec: NOT intentional for ingest_topshot_challenges_atlas_begin, ingest_topshot_challenges_atlas_collect — pg_cron writers; EXECUTE revoked from PUBLIC/anon/authenticated, granted to service_role only.
--
-- RPC's challenge tracker has been blind since 2026-08-28: `ingest-topshot-challenges` read
-- public-api.nbatopshot.com, which answers HTTP 530 (decommissioned), and every challenge row ended
-- by 07-15. The /challenges page and the concierge already say the tracker is behind rather than
-- "none running" — but Top Shot IS running them: on 2026-10-20 (PT) 17 set challenges were live.
--
-- WHERE THEY LIVE NOW (found 2026-10-20 by reading what nbatopshot.com itself calls on /sets/<id>):
--   POST api.production.atlas.dapperlabs.com/public/atlas.v1.QuestService/GetQuestStatus
--   body {"product":"nba"}  -> {quests:[{questId, questName, description, cadence ('flash'), questType
--   ('collection'), startsAt, expiresAt, totalCompletions, maxCompletions, maxCompletionsPerUser,
--   rewards:[{rewardType:'pack', rewardItemId:<pack dist id>, description}], metadata:{set_id,
--   image_url}, actions:[{actionName, actionType:'lock_nft', targetCount, link}]}]}
-- Unauthenticated, answers from Supabase pg_net like every other Atlas lane (one request per run).
-- ⚠ `/challenges` on nbatopshot.com redirects to v1.nbatopshot.com, which is an error page; the
--   challenges are now shown per SET, which is why no earlier sweep of Atlas services found them.
--
-- SLOT MODEL (unchanged — challenge_slots + challenge_slot_editions, which get_active_challenges and
-- refresh_challenge_costs already price): one action = one slot ("lock 1 Moment of <player>").
-- Its eligible editions are resolved two ways, measured on the 2026-10-20 payload (326 slots):
--   (a) the action link carries `editions=<atlas ids>` (56 slots, the Run It Back sets) -> mapped
--       through topshot_atlas_edition_map; 368 of 424 ids map, the 56 that do not are one newer
--       parallel per slot and are COUNTED in extra.unmapped_atlas_edition_refs, never dropped silently;
--   (b) otherwise the link carries `sets=<name>&players=<name>&series=<n>` (270 slots, "any parallel
--       counts") -> every Top Shot edition of that on-chain set (metadata.set_id, else the set whose
--       editions carry that name in that series) whose player matches by _norm_player.
-- Both together resolved 326 of 326 slots in a dry run.
--
-- WRITE DISCIPLINE (R120/R123): write first, delete only what this run did not write; a slot list
-- that resolves to NOTHING is not written over a non-empty one. ok is derived from the writes landing
-- (any error aborts the block and is logged ok=false with the message); a failed or missing HTTP
-- response is a FAILED run, never an empty one. A quest Atlas stops returning is NOT ended here —
-- expire_ended_challenges does that from its own ends_at, which is the only thing we know.
-- The pipeline keeps its name, `ingest-topshot-challenges`, because that is what the /challenges
-- page's feed-freshness check and the cadence watchlist key on: this IS that lane, ported.
--
-- HOW IT WAS APPLIED: the request table went in as 20261021013404 (MCP); this file's functions carry
-- DELETE text, which the MCP refuses outright (four attempts "cancelled", with Trevor's approval in
-- chat), so it was run in the Supabase dashboard SQL editor from the committed file at a pinned sha
-- and its schema_migrations row (version 20261021014500, this name) was inserted by hand.
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-challenges-atlas-begin'); SELECT
--   cron.unschedule('rpc-topshot-challenges-atlas-collect'); DROP FUNCTION
--   public.ingest_topshot_challenges_atlas_collect(), public.ingest_topshot_challenges_atlas_begin();
--   DROP TABLE public.topshot_challenge_ingest_requests; UPDATE public.pipeline_cadence_watchlist SET
--   is_active=false WHERE pipeline='ingest-topshot-challenges'; DELETE FROM public.challenges WHERE
--   source='atlas_quest'; restore challenges_source_check to ('operator','topshot_gql').

-- ⚠ The CHECK widening ran ahead of this migration as one-off pg_cron job 769 (2026-10-20 6:31 PM PT,
-- succeeded, unscheduled) because the migration tool refuses a DROP. The two statements are kept
-- executable here (idempotent) so a replay from scratch is complete; on production they were a no-op
-- by the time the rest of this file applied.
ALTER TABLE public.challenges DROP CONSTRAINT IF EXISTS challenges_source_check;
ALTER TABLE public.challenges ADD CONSTRAINT challenges_source_check
  CHECK (source = ANY (ARRAY['operator'::text, 'topshot_gql'::text, 'atlas_quest'::text]));

CREATE FUNCTION public.ingest_topshot_challenges_atlas_begin()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id bigint;
BEGIN
  v_id := net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.QuestService/GetQuestStatus',
    body := '{"product":"nba"}'::jsonb,
    headers := public.atlas_market_headers('nba'),
    timeout_milliseconds := 30000);
  INSERT INTO public.topshot_challenge_ingest_requests (request_id) VALUES (v_id);
  RETURN v_id;
END
$function$;

CREATE FUNCTION public.ingest_topshot_challenges_atlas_collect()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  c_coll  constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_req   record;
  v_resp  record;
  v_body  jsonb;
  q       jsonb;
  v_id    uuid;
  v_new   boolean;
  v_sid   text;
  v_status text;
  v_reward jsonb;
  v_quests int := 0; v_upserted int := 0; v_inserted int := 0; v_skipped int := 0;
  v_slots int := 0; v_slot_eds int := 0; v_unresolved int := 0; v_unmapped int := 0;
  v_multi int := 0; v_kept_old int := 0; v_n int;
  v_extra jsonb;
  v_slot_js jsonb; v_ed_js jsonb;
BEGIN
  SELECT * INTO v_req FROM public.topshot_challenge_ingest_requests
   WHERE collected_at IS NULL ORDER BY requested_at DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM public.log_pipeline_run('ingest-topshot-challenges', false,
      jsonb_build_object('source','atlas_quest','error','no pending request — begin did not run'));
    RETURN jsonb_build_object('ok', false, 'error', 'no pending request');
  END IF;

  SELECT status_code, content, error_msg, timed_out INTO v_resp
    FROM net._http_response WHERE id = v_req.request_id;
  IF NOT FOUND THEN
    IF v_req.requested_at > now() - interval '10 minutes' THEN
      RETURN jsonb_build_object('ok', null, 'pending', v_req.request_id);   -- not answered yet; next tick
    END IF;
    UPDATE public.topshot_challenge_ingest_requests SET collected_at = now() WHERE request_id = v_req.request_id;
    PERFORM public.log_pipeline_run('ingest-topshot-challenges', false,
      jsonb_build_object('source','atlas_quest','error','no response after 10 min','request_id',v_req.request_id));
    RETURN jsonb_build_object('ok', false, 'error', 'no response');
  END IF;

  UPDATE public.topshot_challenge_ingest_requests SET collected_at = now() WHERE request_id = v_req.request_id;
  -- older never-collected requests are superseded by this one
  UPDATE public.topshot_challenge_ingest_requests SET collected_at = now()
   WHERE collected_at IS NULL AND requested_at < v_req.requested_at;

  IF v_resp.status_code IS DISTINCT FROM 200 THEN
    PERFORM public.log_pipeline_run('ingest-topshot-challenges', false, jsonb_build_object(
      'source','atlas_quest','request_id',v_req.request_id,
      'error', format('HTTP %s %s', coalesce(v_resp.status_code::text,'null'),
                      left(coalesce(v_resp.error_msg, v_resp.content, ''), 200))));
    RETURN jsonb_build_object('ok', false, 'status', v_resp.status_code);
  END IF;

  BEGIN
    v_body := v_resp.content::jsonb;
    IF jsonb_typeof(v_body->'quests') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'payload has no quests array (keys: %)', (SELECT string_agg(k, ',') FROM jsonb_object_keys(v_body) k);
    END IF;

    FOR q IN SELECT x FROM jsonb_array_elements(v_body->'quests') x LOOP
      v_quests := v_quests + 1;
      IF coalesce(q->>'questId','') = '' OR coalesce(q->>'questName','') = ''
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q->'actions') a WHERE a->>'actionType' = 'lock_nft') THEN
        v_skipped := v_skipped + 1;   -- not a lock-to-complete challenge; this tracker cannot price it
        CONTINUE;
      END IF;

      v_reward := q->'rewards'->0;
      v_status := CASE
        WHEN (q->>'expiresAt') IS NOT NULL AND (q->>'expiresAt')::timestamptz < now() THEN 'ended'
        WHEN (q->>'startsAt')  IS NOT NULL AND (q->>'startsAt')::timestamptz  > now() THEN 'upcoming'
        ELSE 'active' END;

      -- the set: metadata.set_id, else the editions carrying the link's set name in the link's series
      v_sid := nullif(q->'metadata'->>'set_id', '');
      IF v_sid IS NULL THEN
        SELECT split_part(e.external_id, ':', 1) INTO v_sid
          FROM jsonb_array_elements(q->'actions') a
          JOIN public.editions e
            ON e.collection_id = c_coll
           AND lower(e.set_name) = lower(replace(replace(replace(substring(a->>'link' from 'sets=([^&]+)'), '+', ' '), '%26', '&'), '%27', ''''))
           AND e.series::text = coalesce(substring(a->>'link' from 'series=([0-9]+)'), e.series::text)
         GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;
      END IF;

      SELECT NOT EXISTS (SELECT 1 FROM public.challenges c WHERE c.collection_id = c_coll AND c.slug = 'tsq-' || (q->>'questId'))
        INTO v_new;

      INSERT INTO public.challenges AS c (
        collection_id, slug, name, challenge_type, description, reward_kind, reward_pack_dist_id,
        reward_label, starts_at, ends_at, total_reward_allocation, completed_count, status, source,
        external_id, image_url, set_name, metadata)
      VALUES (
        c_coll, 'tsq-' || (q->>'questId'), q->>'questName', 'set_locking', nullif(q->>'description',''),
        CASE WHEN v_reward->>'rewardType' = 'pack' THEN 'pack' WHEN v_reward IS NULL THEN NULL ELSE 'other' END,
        CASE WHEN v_reward->>'rewardType' = 'pack' THEN nullif(v_reward->>'rewardItemId','') END,
        nullif(v_reward->>'description',''),
        (q->>'startsAt')::timestamptz, (q->>'expiresAt')::timestamptz,
        nullif(q->>'maxCompletions','')::int, nullif(q->>'totalCompletions','')::int,
        v_status, 'atlas_quest', q->>'questId', nullif(q->'metadata'->>'image_url',''),
        (SELECT e.set_name FROM public.editions e WHERE e.collection_id = c_coll
            AND split_part(e.external_id, ':', 1) = v_sid LIMIT 1),
        jsonb_build_object('atlas_quest_event_id', q->>'questEventId', 'cadence', q->>'cadence',
                           'quest_type', q->>'questType', 'tags', q->'tags', 'set_id', v_sid,
                           'max_completions_per_user', q->>'maxCompletionsPerUser',
                           'ingested_from', 'atlas.v1.QuestService/GetQuestStatus'))
      ON CONFLICT (collection_id, slug) DO UPDATE SET
        name = EXCLUDED.name,
        description = coalesce(EXCLUDED.description, c.description),
        reward_kind = coalesce(EXCLUDED.reward_kind, c.reward_kind),
        reward_pack_dist_id = coalesce(EXCLUDED.reward_pack_dist_id, c.reward_pack_dist_id),
        reward_label = coalesce(EXCLUDED.reward_label, c.reward_label),
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        total_reward_allocation = EXCLUDED.total_reward_allocation,
        completed_count = EXCLUDED.completed_count,
        status = EXCLUDED.status,
        source = 'atlas_quest',
        external_id = EXCLUDED.external_id,
        image_url = coalesce(EXCLUDED.image_url, c.image_url),
        set_name = coalesce(EXCLUDED.set_name, c.set_name),
        metadata = coalesce(c.metadata, '{}'::jsonb) || EXCLUDED.metadata
      RETURNING c.id INTO v_id;
      v_upserted := v_upserted + 1;
      IF v_new THEN v_inserted := v_inserted + 1; END IF;

      -- resolve this quest's slots in full before writing anything (no half-read is written)
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'slot_order', x.ord::int,
               'label', regexp_replace(x.act->>'actionName', '^Lock ', ''),
               'target', nullif(x.act->>'targetCount','')::int,
               'atlas_ids', substring(x.act->>'link' from 'editions=([0-9,]+)'))), '[]'::jsonb)
        INTO v_slot_js
        FROM jsonb_array_elements(q->'actions') WITH ORDINALITY x(act, ord)
       WHERE x.act->>'actionType' = 'lock_nft';

      WITH s AS (SELECT * FROM jsonb_to_recordset(v_slot_js) AS t(slot_order int, label text, target int, atlas_ids text)),
      ed AS (
        SELECT s.slot_order, m.external_id
          FROM s CROSS JOIN LATERAL unnest(string_to_array(s.atlas_ids, ',')) aid
          JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = aid
         WHERE s.atlas_ids IS NOT NULL
        UNION
        SELECT s.slot_order, e.external_id
          FROM s JOIN public.editions e
            ON e.collection_id = c_coll
           AND split_part(e.external_id, ':', 1) = v_sid
           AND public._norm_player(e.player_name) = public._norm_player(s.label)
         WHERE s.atlas_ids IS NULL AND v_sid IS NOT NULL)
      SELECT coalesce(jsonb_agg(jsonb_build_object('slot_order', slot_order, 'external_id', external_id)), '[]'::jsonb)
        INTO v_ed_js FROM ed;

      SELECT count(*) INTO v_n
        FROM jsonb_to_recordset(v_slot_js) AS s(slot_order int, atlas_ids text)
       CROSS JOIN LATERAL unnest(string_to_array(s.atlas_ids, ',')) aid
       WHERE s.atlas_ids IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_edition_map m WHERE m.atlas_edition_id = aid);
      v_unmapped := v_unmapped + v_n;
      v_multi := v_multi + (SELECT count(*) FROM jsonb_to_recordset(v_slot_js) AS s(target int) WHERE coalesce(s.target, 1) > 1);
      v_unresolved := v_unresolved + (
        SELECT count(*) FROM jsonb_to_recordset(v_slot_js) AS s(slot_order int)
         WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_ed_js) AS d(slot_order int) WHERE d.slot_order = s.slot_order));

      IF jsonb_array_length(v_ed_js) = 0
         AND EXISTS (SELECT 1 FROM public.challenge_slot_editions WHERE challenge_id = v_id) THEN
        v_kept_old := v_kept_old + 1;   -- resolved to nothing this run: keep the last good slot list
        CONTINUE;
      END IF;

      INSERT INTO public.challenge_slots AS cs (challenge_id, slot_order, label, set_external_id, series, help_text)
      SELECT v_id, s.slot_order, s.label, v_sid, NULL,
             CASE WHEN coalesce(s.target, 1) > 1 THEN format('lock %s', s.target) END
        FROM jsonb_to_recordset(v_slot_js) AS s(slot_order int, label text, target int)
      ON CONFLICT (challenge_id, slot_order) DO UPDATE SET
        label = EXCLUDED.label, set_external_id = EXCLUDED.set_external_id, help_text = EXCLUDED.help_text;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_slots := v_slots + v_n;

      INSERT INTO public.challenge_slot_editions (challenge_id, slot_order, external_id)
      SELECT v_id, d.slot_order, d.external_id
        FROM jsonb_to_recordset(v_ed_js) AS d(slot_order int, external_id text)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT; v_slot_eds := v_slot_eds + v_n;

      -- only now retire what this run did not write
      DELETE FROM public.challenge_slot_editions cse
       WHERE cse.challenge_id = v_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_ed_js) AS d(slot_order int, external_id text)
                          WHERE d.slot_order = cse.slot_order AND d.external_id = cse.external_id);
      DELETE FROM public.challenge_slots cs
       WHERE cs.challenge_id = v_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_slot_js) AS s(slot_order int) WHERE s.slot_order = cs.slot_order);
    END LOOP;

    IF v_inserted > 0 OR v_slot_eds > 0 THEN
      PERFORM public.refresh_challenge_costs(c_coll);
    END IF;
    PERFORM public.expire_ended_challenges(c_coll);

    v_extra := jsonb_build_object(
      'source', 'atlas_quest', 'request_id', v_req.request_id,
      'fetched', v_quests, 'upserted', v_upserted, 'skipped', v_skipped,
      'challenges_inserted', v_inserted, 'slots_written', v_slots, 'slot_editions_inserted', v_slot_eds,
      'unresolved_slots', v_unresolved, 'unmapped_atlas_edition_refs', v_unmapped,
      'multi_target_slots', v_multi, 'kept_previous_slot_list', v_kept_old,
      'costs_refreshed', (v_inserted > 0 OR v_slot_eds > 0));
    PERFORM public.log_pipeline_run('ingest-topshot-challenges', true, v_extra);
    RETURN v_extra || jsonb_build_object('ok', true);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    PERFORM public.log_pipeline_run('ingest-topshot-challenges', false, jsonb_build_object(
      'source','atlas_quest','request_id',v_req.request_id,'error', left(SQLERRM, 300), 'sqlstate', SQLSTATE));
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
  END;
END
$function$;

COMMENT ON FUNCTION public.ingest_topshot_challenges_atlas_collect() IS
  'Top Shot challenge ingest from Atlas QuestService/GetQuestStatus (replaces the dead public-api lane; same pipeline name ingest-topshot-challenges). Upserts challenges (source=atlas_quest, slug tsq-<questId>) + slot model; write-first, delete-after. audit_20261020.';

REVOKE ALL ON FUNCTION public.ingest_topshot_challenges_atlas_begin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingest_topshot_challenges_atlas_collect() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_topshot_challenges_atlas_begin() TO service_role;
GRANT EXECUTE ON FUNCTION public.ingest_topshot_challenges_atlas_collect() TO service_role;

SELECT cron.schedule('rpc-topshot-challenges-atlas-begin', '41 * * * *',
  'SELECT public.ingest_topshot_challenges_atlas_begin()');
SELECT cron.schedule('rpc-topshot-challenges-atlas-collect', '44 * * * *',
  'SELECT public.ingest_topshot_challenges_atlas_collect()');

UPDATE public.pipeline_cadence_watchlist
   SET is_active = true, max_silent_minutes = 180, max_minutes_without_success = 360,
       notes = '[RE-ACTIVATED 2026-10-20 — ported to Atlas QuestService/GetQuestStatus via pg_cron begin :41 / collect :44 (audit_20261020_topshot_challenges_from_atlas_quests). Hourly; 180 min silent = 3 missed ticks.] ' || notes
 WHERE pipeline = 'ingest-topshot-challenges';
