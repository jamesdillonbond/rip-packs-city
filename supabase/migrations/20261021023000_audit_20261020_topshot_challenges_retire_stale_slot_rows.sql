-- audit_20261020_topshot_challenges_retire_stale_slot_rows
-- anon-exec: unchanged for ingest_topshot_challenges_atlas_collect — CREATE OR REPLACE keeps its ACL (service_role only, set in 20261021022355).
--
-- APPLIED 2026-10-20 ~10:45 PM PT through the Supabase dashboard SQL editor in Trevor's Chrome (Cowork
-- cloud, Trevor approved in chat), then its schema_migrations row inserted by hand (version 20261021023000,
-- this name). Every MCP route refuses SQL containing DELETE, which is why it did not go through apply_migration.
-- Amended before apply (Cowork): the retires are COUNTED (extra.stale_rows_retired, from ROW_COUNT), so the
-- run reports what it removed instead of dropping the stale_rows_not_retired key with nothing in its place.
-- Also amended: a slot that resolved to NOTHING this run keeps its eligible editions (per-slot form of the
-- kept_previous_slot_list rule); costs refresh when anything was retired.
--
-- What it adds to 20261021022355: after writing a challenge's slots and eligible editions, retire the
-- rows this run did NOT write (write first, then retire only the difference, R123), instead of only
-- counting them in extra.stale_rows_not_retired. Until it lands, an eligible-edition list can only grow;
-- watch that count. Same body otherwise (incl. WHEN query_canceled OR OTHERS, R118).
--
-- REVERT: re-apply the collect function from 20261021022355.

CREATE OR REPLACE FUNCTION public.ingest_topshot_challenges_atlas_collect()
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
  v_retired int := 0;
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

      -- only now retire what this run did not write — and only inside a slot that resolved to at least
      -- one edition THIS run (a slot that resolved to nothing keeps its last good list, the per-slot form
      -- of the kept_previous_slot_list rule above; it is still counted in unresolved_slots)
      DELETE FROM public.challenge_slot_editions cse
       WHERE cse.challenge_id = v_id
         AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v_ed_js) AS r(slot_order int) WHERE r.slot_order = cse.slot_order)
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_ed_js) AS d(slot_order int, external_id text)
                          WHERE d.slot_order = cse.slot_order AND d.external_id = cse.external_id);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_retired := v_retired + v_n;
      DELETE FROM public.challenge_slots cs
       WHERE cs.challenge_id = v_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_slot_js) AS s(slot_order int) WHERE s.slot_order = cs.slot_order);
      GET DIAGNOSTICS v_n = ROW_COUNT; v_retired := v_retired + v_n;
    END LOOP;

    IF v_inserted > 0 OR v_slot_eds > 0 OR v_retired > 0 THEN   -- a retired edition can move a slot's cheapest pick
      PERFORM public.refresh_challenge_costs(c_coll);
    END IF;
    PERFORM public.expire_ended_challenges(c_coll);

    v_extra := jsonb_build_object(
      'source', 'atlas_quest', 'request_id', v_req.request_id,
      'fetched', v_quests, 'upserted', v_upserted, 'skipped', v_skipped,
      'challenges_inserted', v_inserted, 'slots_written', v_slots, 'slot_editions_inserted', v_slot_eds,
      'unresolved_slots', v_unresolved, 'unmapped_atlas_edition_refs', v_unmapped,
      'multi_target_slots', v_multi, 'kept_previous_slot_list', v_kept_old,
      'stale_rows_retired', v_retired,
      'costs_refreshed', (v_inserted > 0 OR v_slot_eds > 0 OR v_retired > 0));
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
  'Top Shot challenge ingest from Atlas QuestService/GetQuestStatus (replaces the dead public-api lane; same pipeline name ingest-topshot-challenges). Upserts challenges (source=atlas_quest, slug tsq-<questId>) + slot model; write-first, then retire only rows this run did not write (20261021023000). audit_20261020.';
