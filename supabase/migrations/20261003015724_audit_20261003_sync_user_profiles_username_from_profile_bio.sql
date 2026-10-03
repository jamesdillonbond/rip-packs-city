-- Keep user_profiles.username equal to the RPC profile handle (profile_bio.username).
-- 2026-10-03: user_profiles.username was NULL for all 36 accounts; backfilled 32 by hand
-- (30 from profile_bio, 2 from allow_list). These triggers keep it filled going forward.
-- Guarded: a handle already held by ANOTHER user_profiles row is skipped, never raised,
-- so a profile_bio claim/rename can never fail because of this sync.

CREATE FUNCTION public.sync_user_profiles_username_from_bio()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.username IS NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    UPDATE public.user_profiles up
       SET username = NEW.username,
           updated_at = now()
     WHERE up.id = NEW.user_id
       AND up.username IS DISTINCT FROM NEW.username
       AND NOT EXISTS (
             SELECT 1 FROM public.user_profiles o
              WHERE o.username = NEW.username AND o.id <> NEW.user_id);
  EXCEPTION WHEN unique_violation THEN
    NULL; -- concurrent claim of the same handle; the bio write must still succeed
  END;
  RETURN NEW;
END;
$$;
-- anon-exec: revoked (sync_user_profiles_username_from_bio) — trigger-only fn; no client should call it.
REVOKE EXECUTE ON FUNCTION public.sync_user_profiles_username_from_bio() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_profile_bio_sync_username
AFTER INSERT OR UPDATE OF username ON public.profile_bio
FOR EACH ROW EXECUTE FUNCTION public.sync_user_profiles_username_from_bio();

CREATE FUNCTION public.fill_user_profiles_username_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v text;
BEGIN
  IF NEW.username IS NULL THEN
    SELECT b.username INTO v FROM public.profile_bio b WHERE b.user_id = NEW.id;
    IF v IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.user_profiles o WHERE o.username = v AND o.id <> NEW.id) THEN
      NEW.username := v;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- anon-exec: revoked (fill_user_profiles_username_on_insert) — trigger-only fn; no client should call it.
REVOKE EXECUTE ON FUNCTION public.fill_user_profiles_username_on_insert() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_user_profiles_fill_username
BEFORE INSERT ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.fill_user_profiles_username_on_insert();