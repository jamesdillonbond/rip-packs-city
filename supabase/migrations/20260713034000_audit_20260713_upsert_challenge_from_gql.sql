-- Ingest seam for the automated searchChallenges feed: upsert one VARIABLE challenge and
-- REPLACE its slots. Preserves operator-set reward linkage (reward_pack_dist_id / reward
-- moment) on an existing row — the GQL feed doesn't carry the completion-pack dist id.
-- Returns the challenge id. The caller runs resolve_challenge_slots() + refresh_challenge_costs()
-- once after all challenges are upserted.
CREATE OR REPLACE FUNCTION public.upsert_challenge_from_gql(
  p_external_id     text,
  p_name            text,
  p_description     text,
  p_ends_at         timestamptz,
  p_completed_count integer,
  p_total_alloc     integer,
  p_image_url       text,
  p_set_external_id text,
  p_slots           jsonb,
  p_collection_id   uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '30s'
AS $$
DECLARE v_id uuid; v_set_name text; v_slug text := 'ts-' || p_external_id;
BEGIN
  IF p_external_id IS NULL OR btrim(p_external_id) = '' OR p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'upsert_challenge_from_gql: external_id and name are required';
  END IF;

  SELECT name INTO v_set_name FROM public.sets
   WHERE external_id = p_set_external_id AND collection_id = p_collection_id LIMIT 1;

  INSERT INTO public.challenges (
    collection_id, slug, name, challenge_type, description, reward_kind, status, source,
    external_id, image_url, set_name, ends_at, completed_count, total_reward_allocation, updated_at
  ) VALUES (
    p_collection_id, v_slug, p_name, 'set_locking', p_description, 'pack', 'active', 'topshot_gql',
    p_external_id, p_image_url, v_set_name, p_ends_at, p_completed_count, p_total_alloc, now()
  )
  ON CONFLICT (collection_id, slug) DO UPDATE SET
    name = EXCLUDED.name,
    description = COALESCE(EXCLUDED.description, public.challenges.description),
    status = 'active',
    source = 'topshot_gql',
    external_id = EXCLUDED.external_id,
    image_url = COALESCE(EXCLUDED.image_url, public.challenges.image_url),
    set_name = COALESCE(EXCLUDED.set_name, public.challenges.set_name),
    ends_at = EXCLUDED.ends_at,
    completed_count = EXCLUDED.completed_count,
    total_reward_allocation = COALESCE(EXCLUDED.total_reward_allocation, public.challenges.total_reward_allocation),
    updated_at = now()
    -- reward_kind / reward_pack_dist_id / reward_moment_external_id deliberately preserved
  RETURNING id INTO v_id;

  DELETE FROM public.challenge_slots WHERE challenge_id = v_id;
  INSERT INTO public.challenge_slots (challenge_id, slot_order, label, nba_stats_id, set_external_id, series, play_category, help_text)
  SELECT v_id,
         (s->>'slot_order')::int,
         s->>'label',
         NULLIF(s->>'nba_stats_id',''),
         p_set_external_id,
         COALESCE(NULLIF(s->>'series',''), '8'),
         NULLIF(s->>'play_category',''),
         NULLIF(s->>'help_text','')
  FROM jsonb_array_elements(COALESCE(p_slots,'[]'::jsonb)) s
  WHERE s ? 'slot_order'
  ON CONFLICT (challenge_id, slot_order) DO NOTHING;

  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.upsert_challenge_from_gql(text,text,text,timestamptz,integer,integer,text,text,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_challenge_from_gql(text,text,text,timestamptz,integer,integer,text,text,jsonb,uuid) TO service_role, postgres;
