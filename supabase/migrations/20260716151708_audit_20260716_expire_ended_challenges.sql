-- Expiry pass for the automated challenge ingest. The searchChallenges feed only returns
-- ACTIVE challenges; once a wave ends upstream its row is never re-upserted, so it stays
-- status='active' forever (the display RPCs hide it via the ends_at filter, but the DATA
-- still lies). This flips any challenge whose window has closed to status='ended'.
--
-- Purely time-based (ends_at < now()), so a transient partial fetch can NEVER wrongly expire
-- a still-future challenge — a genuinely-active challenge has ends_at > now() and is untouched.
-- Called every ingest tick regardless of upsert count (a challenge that dropped out of the
-- feed is never upserted, so it must be expired independently).
-- Revert: DROP FUNCTION public.expire_ended_challenges(uuid);
CREATE OR REPLACE FUNCTION public.expire_ended_challenges(
  p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '30s'
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.challenges
     SET status = 'ended'          -- updated_at is owned by the challenges_touch_updated_at trigger
   WHERE collection_id = p_collection_id
     AND status = 'active'
     AND ends_at IS NOT NULL
     AND ends_at < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.expire_ended_challenges(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_ended_challenges(uuid) TO service_role, postgres;
