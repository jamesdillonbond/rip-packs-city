-- _norm_player: unaccent + lowercase + strip suffixes + strip non-alnum. Used to match a
-- slot's player label to editions.player_name within the slot's set.
CREATE OR REPLACE FUNCTION public._norm_player(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,extensions AS $$
  SELECT regexp_replace(
           regexp_replace(lower(extensions.unaccent(coalesce(p,''))),
             '\s+(jr|sr|ii|iii|iv|v)\.?$', '', 'g'),
           '[^a-z0-9]', '', 'g')
$$;

-- Resolve every challenge slot to the editions that satisfy it (set + player + optional
-- play-category). Exact normalized-name match is preferred per slot; trigram (>0.6) only
-- fills a slot with no exact match, so a good exact match is never polluted by a fuzzy one.
-- Side effect: backfills players.nba_stats_id from slots that resolve to exactly one player
-- (the durable NBA-stats-id -> our-player bridge the automated ingest reuses).
-- Idempotent: rebuilds challenge_slot_editions for the collection each call.
CREATE OR REPLACE FUNCTION public.resolve_challenge_slots(
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions SET statement_timeout='180s'
AS $$
DECLARE v_slots int; v_eds int; v_unresolved int; v_nba int;
BEGIN
  DELETE FROM public.challenge_slot_editions cse
  USING public.challenge_slots cs, public.challenges c
  WHERE cse.challenge_id=cs.challenge_id AND cse.slot_order=cs.slot_order
    AND cs.challenge_id=c.id AND c.collection_id=p_collection_id;

  WITH e AS (
    SELECT s.external_id AS set_uuid, ed.external_id, ed.play_id_onchain, ed.play_category,
           public._norm_player(ed.player_name) AS pn
    FROM public.editions ed JOIN public.sets s ON s.id=ed.set_id
    WHERE ed.collection_id=p_collection_id
  ),
  m AS (
    SELECT cs.challenge_id, cs.slot_order, e.external_id, e.play_id_onchain,
           (e.pn = public._norm_player(cs.label)) AS is_exact
    FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id
    JOIN e ON e.set_uuid=cs.set_external_id
         AND (e.pn = public._norm_player(cs.label) OR extensions.similarity(e.pn, public._norm_player(cs.label)) > 0.6)
         AND (cs.play_category IS NULL OR e.play_category = cs.play_category)
  ),
  ranked AS (
    SELECT *, bool_or(is_exact) OVER (PARTITION BY challenge_id, slot_order) AS slot_has_exact FROM m
  )
  INSERT INTO public.challenge_slot_editions (challenge_id, slot_order, external_id, play_id_onchain)
  SELECT DISTINCT challenge_id, slot_order, external_id, play_id_onchain
  FROM ranked WHERE is_exact OR NOT slot_has_exact
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_eds = ROW_COUNT;

  WITH e AS (
    SELECT s.external_id AS set_uuid, ed.player_id, public._norm_player(ed.player_name) AS pn
    FROM public.editions ed JOIN public.sets s ON s.id=ed.set_id
    WHERE ed.collection_id=p_collection_id
  ),
  slot_players AS (
    SELECT cs.nba_stats_id, (array_agg(DISTINCT e.player_id))[1] AS player_id
    FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id
    JOIN e ON e.set_uuid=cs.set_external_id
         AND (e.pn = public._norm_player(cs.label) OR extensions.similarity(e.pn, public._norm_player(cs.label)) > 0.6)
    WHERE cs.nba_stats_id IS NOT NULL
    GROUP BY cs.nba_stats_id
    HAVING count(DISTINCT e.player_id)=1
  )
  UPDATE public.players p SET nba_stats_id=sp.nba_stats_id
  FROM slot_players sp
  WHERE p.id=sp.player_id AND p.collection_id=p_collection_id
    AND p.nba_stats_id IS DISTINCT FROM sp.nba_stats_id;
  GET DIAGNOSTICS v_nba = ROW_COUNT;

  SELECT count(*) INTO v_slots FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id;
  SELECT count(*) INTO v_unresolved FROM public.challenge_slots cs
    JOIN public.challenges c ON c.id=cs.challenge_id AND c.collection_id=p_collection_id
    WHERE NOT EXISTS (SELECT 1 FROM public.challenge_slot_editions cse
                      WHERE cse.challenge_id=cs.challenge_id AND cse.slot_order=cs.slot_order);

  RETURN jsonb_build_object('slots',v_slots,'slot_editions',v_eds,'nba_ids_backfilled',v_nba,'unresolved_slots',v_unresolved);
END $$;
REVOKE ALL ON FUNCTION public.resolve_challenge_slots(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_challenge_slots(uuid) TO service_role, postgres;
