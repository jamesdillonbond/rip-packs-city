-- Supabase ALTER DEFAULT PRIVILEGES grants anon/authenticated EXECUTE on every new
-- public function, so REVOKE ... FROM PUBLIC leaves those explicit grants in place.
-- The threshold fn is only ever called from a service_role-gated view and a SECDEF
-- fn (which runs as its owner), so drop the anon/authenticated surface entirely.
REVOKE EXECUTE ON FUNCTION public.cursor_stall_threshold() FROM anon, authenticated;