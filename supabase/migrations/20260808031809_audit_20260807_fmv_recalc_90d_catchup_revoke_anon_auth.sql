-- Supabase default privileges auto-grant EXECUTE on new public functions to
-- anon + authenticated as EXPLICIT rows, which a REVOKE ... FROM PUBLIC does not
-- touch. Strip them so the SECDEF catch-up enumeration is service_role-only,
-- matching fmv_recalc_edition_page's posture ({postgres,service_role}).
REVOKE EXECUTE ON FUNCTION public.fmv_recalc_90d_catchup_editions(uuid, integer) FROM anon, authenticated;
