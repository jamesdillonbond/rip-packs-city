-- Snapshot migration: commit the VERBATIM live body of public.ensure_topshot_edition_stub
-- so the DB-invariant test (supabase/tests/ensure_topshot_edition_stub.sql) has a
-- committed source the drift guard can compare against. The repo carries the ORIGINAL
-- audit_20260523 definition, but the live function has since diverged (the self-heal
-- bridge described in CLAUDE.md); this snapshot captures the CURRENT live body so the
-- pin validates what actually runs. Verified against live via pg_get_functiondef.
--
-- This function is the self-heal that lets a NEW Top Shot set resolve with no manual
-- seeding: the GQL editions-catalog creates `sets` rows keyed by the TopShot UUID
-- (external_id) but leaves set_id_onchain NULL, so a stub lookup by (set_id_onchain,
-- play_id_onchain) misses. The function bridges UUID→set_id_onchain via a sibling
-- edition and backfills it, then inserts the stub inheriting tier/series from the
-- parent set. A regression here means new sets silently fail to resolve (catalog_gap
-- forever) or stubs land with the wrong tier/series. Re-applying is a no-op.

CREATE OR REPLACE FUNCTION public.ensure_topshot_edition_stub(p_set_id_onchain integer, p_play_id_onchain integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_collection_id uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_edition_id uuid;
  v_set_uuid uuid;
  v_set_name text;
  v_set_tier tier_type;
  v_set_series int;
BEGIN
  -- Fast path: edition already exists
  SELECT id INTO v_edition_id
  FROM editions
  WHERE collection_id = v_collection_id
    AND set_id_onchain = p_set_id_onchain
    AND play_id_onchain = p_play_id_onchain
  LIMIT 1;

  IF v_edition_id IS NOT NULL THEN
    RETURN v_edition_id;
  END IF;

  -- Look up parent set to inherit defaults
  SELECT id, name, tier, series
    INTO v_set_uuid, v_set_name, v_set_tier, v_set_series
  FROM sets
  WHERE collection_id = v_collection_id
    AND set_id_onchain = p_set_id_onchain
  LIMIT 1;

  IF v_set_uuid IS NULL THEN
    -- Self-heal: the GQL editions-catalog creates `sets` rows keyed by the
    -- TopShot UUID (external_id) but does not populate set_id_onchain, so the
    -- lookup above misses. Bridge via a sibling edition that carries both the
    -- UUID (external_id prefix) and the integer set_id_onchain, and backfill
    -- set_id_onchain onto the existing sets row so this and every future
    -- lookup resolves. Replaces the one-off audit_20260523 sets backfill.
    UPDATE sets s
    SET set_id_onchain = p_set_id_onchain, updated_at = now()
    FROM (
      SELECT split_part(external_id, ':', 1) AS set_uuid
      FROM editions
      WHERE collection_id = v_collection_id
        AND set_id_onchain = p_set_id_onchain
        AND length(split_part(external_id, ':', 1)) = 36
      LIMIT 1
    ) m
    WHERE s.collection_id = v_collection_id
      AND s.external_id = m.set_uuid
      AND s.set_id_onchain IS NULL
    RETURNING s.id, s.name, s.tier, s.series
      INTO v_set_uuid, v_set_name, v_set_tier, v_set_series;

    IF v_set_uuid IS NULL THEN
      -- Genuinely uncataloged: the GQL catalog has not yet created the set
      -- (and editions) for this set_id_onchain. Caller logs catalog_gap; it
      -- resolves on a later tick once the catalog has run.
      RETURN NULL;
    END IF;
  END IF;

  -- Insert the stub. tier and series come from the parent set; player/team/circulation
  -- left NULL for the downstream backfill-topshot-catalog pipeline to hydrate.
  INSERT INTO public.editions (
    external_id, collection_id, set_id, tier, series, edition_kind,
    set_id_onchain, play_id_onchain, collection, set_name,
    created_at, updated_at
  )
  VALUES (
    p_set_id_onchain::text || ':' || p_play_id_onchain::text,
    v_collection_id, v_set_uuid, v_set_tier, v_set_series, 'LE',
    p_set_id_onchain, p_play_id_onchain, 'nba_top_shot', v_set_name,
    now(), now()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_edition_id;

  -- ON CONFLICT branch (raced with another writer): re-select
  IF v_edition_id IS NULL THEN
    SELECT id INTO v_edition_id
    FROM editions
    WHERE collection_id = v_collection_id
      AND set_id_onchain = p_set_id_onchain
      AND play_id_onchain = p_play_id_onchain
    LIMIT 1;
  END IF;

  RETURN v_edition_id;
END;
$function$;
