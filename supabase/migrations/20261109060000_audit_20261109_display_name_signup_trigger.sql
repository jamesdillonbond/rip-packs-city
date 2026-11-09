-- audit_20261109_display_name_signup_trigger
-- Durable fix for display_name staying NULL at signup: when a wallet's
-- proper-cased handle lands in wallet_usernames, copy it to display_name on
-- every profile that saved that wallet. Fills only NULL or all-lowercase
-- display names, and only when the handle is a casing variant of the slug
-- (divergent handles are left for a manual decision). Never touches the slug.
-- Handoff: claude/handoff-2026-11-09-display-name-signup-trigger.md
-- Revert:
--   DROP TRIGGER IF EXISTS trg_wallet_usernames_fill_display_name ON public.wallet_usernames;
--   DROP FUNCTION IF EXISTS public.fill_display_name_from_wallet_username();

CREATE OR REPLACE FUNCTION public.fill_display_name_from_wallet_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $fn$
BEGIN
  IF NEW.username IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.user_profiles up
     SET display_name = NEW.username, updated_at = now()
    FROM public.saved_wallets s
   WHERE s.wallet_addr = NEW.wallet_addr
     AND s.user_id = up.id
     AND (up.display_name IS NULL OR up.display_name = lower(up.display_name))
     AND (up.username IS NULL OR lower(up.username) = lower(NEW.username));

  UPDATE public.profile_bio pb
     SET display_name = NEW.username, updated_at = now()
    FROM public.saved_wallets s
   WHERE s.wallet_addr = NEW.wallet_addr
     AND s.user_id = pb.user_id
     AND (pb.display_name IS NULL OR pb.display_name = lower(pb.display_name))
     AND (pb.username IS NULL OR lower(pb.username) = lower(NEW.username));

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fill_display_name_from_wallet_username() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fill_display_name_from_wallet_username() IS
  'Trigger fn (2026-11-09): copies the proper-cased wallet_usernames handle into user_profiles/profile_bio.display_name when NULL or all-lowercase and a casing variant of the slug.';

DROP TRIGGER IF EXISTS trg_wallet_usernames_fill_display_name ON public.wallet_usernames;
CREATE TRIGGER trg_wallet_usernames_fill_display_name
AFTER INSERT OR UPDATE OF username ON public.wallet_usernames
FOR EACH ROW EXECUTE FUNCTION public.fill_display_name_from_wallet_username();
