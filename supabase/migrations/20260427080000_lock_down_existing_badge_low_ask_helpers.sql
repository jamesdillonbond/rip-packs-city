-- Lock down anon/authenticated EXECUTE on the three pre-existing badge low_ask
-- helpers. These are SECURITY DEFINER and write to badge_editions; combined
-- with the implicit anon grant Supabase applies to public-schema functions
-- on creation, anyone with the public anon key could mass-update or NULL out
-- badge data via POST /rest/v1/rpc/<name>.
--
-- Verified call-site audit (commit 5f6c99a head): every invocation goes
-- through supabaseAdmin (service-role client, lib/supabase.ts:24-27). No
-- anon-key client calls these RPCs anywhere in the repo.
--
-- The original migrations (20260427020000, 20260427070000) did
-- REVOKE ALL ... FROM PUBLIC, which strips the PUBLIC pseudo-role grant
-- but not the explicit grants Supabase auto-applies to anon/authenticated.
-- This migration closes that gap.

REVOKE EXECUTE ON FUNCTION public.update_badge_low_ask_by_external(uuid, jsonb)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.update_badge_low_ask_from_cached_listings(uuid)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.clear_badge_low_ask_missing(uuid, text[])
  FROM anon, authenticated;
