-- Two pre-existing bugs in upsert_topshot_edition_metadata, hidden because
-- the GraphQL-based topshot-stub-resolver always returned null before reaching
-- the upsert call. They surfaced as 50/50 upsert errors once the resolver
-- moved to the Cadence path that actually finds data.
--
-- Bug 1: UPDATE referenced column `team` but editions has `team_name`.
-- Bug 2: p_series was text and NULLIF(series,'') type-mismatched against the
--        actual smallint `series` column.
--
-- Sole caller is supabase/functions/topshot-stub-resolver/index.ts; it now
-- passes numeric series matching the smallint storage. Display-string
-- mapping for series happens at read/render time, not at write time.

DROP FUNCTION IF EXISTS public.upsert_topshot_edition_metadata(
  uuid, text, text, tier_type, integer, text, text, text, text
);

CREATE OR REPLACE FUNCTION public.upsert_topshot_edition_metadata(
  p_edition_id uuid,
  p_player_name text,
  p_set_name text,
  p_tier tier_type,
  p_circulation_count integer DEFAULT NULL,
  p_thumbnail_url text DEFAULT NULL,
  p_video_url text DEFAULT NULL,
  p_team text DEFAULT NULL,
  p_series integer DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE editions
     SET player_name       = COALESCE(NULLIF(player_name,''), p_player_name),
         set_name          = COALESCE(NULLIF(set_name,''),    p_set_name),
         tier              = COALESCE(tier, p_tier),
         circulation_count = COALESCE(circulation_count, p_circulation_count),
         thumbnail_url     = COALESCE(NULLIF(thumbnail_url,''), p_thumbnail_url),
         video_url         = COALESCE(NULLIF(video_url,''), p_video_url),
         team_name         = COALESCE(NULLIF(team_name,''), p_team),
         series            = COALESCE(series, p_series::smallint)
   WHERE id = p_edition_id
     AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_topshot_edition_metadata(
  uuid, text, text, tier_type, integer, text, text, text, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_topshot_edition_metadata(
  uuid, text, text, tier_type, integer, text, text, text, integer
) TO postgres, service_role;
