-- Follow-up to 20260904031944: the trigger function it re-created is a `RETURNS trigger` function,
-- which nothing can call as an RPC, but this database grants anon EXECUTE on new public functions
-- by default and the repo's anon-exec guard asks for the decision on EVERY created function.
-- Trigger FIRING does not check EXECUTE (only CREATE TRIGGER does, as the table owner), so this
-- is behaviour-neutral for the trigger and closes the default grant.
REVOKE ALL ON FUNCTION public.trg_topshot_normalize_base_club_circulation() FROM PUBLIC, anon, authenticated;