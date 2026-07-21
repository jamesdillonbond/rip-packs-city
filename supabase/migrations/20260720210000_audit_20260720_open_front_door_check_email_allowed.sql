-- audit_20260720_open_front_door_check_email_allowed
--
-- OPEN THE FRONT DOOR (2026-07-20, Trevor-directed). Allow ANY email to receive
-- a magic link / pass the authed-route gate, EXCEPT explicitly-blocked emails.
-- Ban hammer: an allow_list row with revoked_at set or a blocking status, OR an
-- active deny_list entry (exact email or whole domain via 'email_domain'), blocks.
-- Stays SECURITY DEFINER + STABLE + service_role-only ACL (anon/authenticated
-- have NO execute — this RPC is only ever called server-side from
-- /api/auth/request-magic-link and proxy.ts).
--
-- Was invite-only: SELECT EXISTS(... allow_list WHERE status='active'). That
-- kept self-serve signup impossible while browsing/search were already public.
--
-- Already applied to prod via MCP as audit_20260720_open_front_door_check_email_allowed
-- + _v2_denylist_types on 2026-07-20; this file is repo/rebuild parity. Re-applying
-- is harmless (idempotent CREATE OR REPLACE).
--
-- REVERT (re-close to invite-only): recreate the strict body —
--   CREATE OR REPLACE FUNCTION public.check_email_allowed(p_email text)
--    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
--    SET search_path TO 'public','pg_temp'
--   AS $$ SELECT EXISTS (SELECT 1 FROM public.allow_list
--                        WHERE lower(email)=lower(trim(p_email)) AND status='active'); $$;

CREATE OR REPLACE FUNCTION public.check_email_allowed(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM public.allow_list a
      WHERE lower(a.email) = lower(trim(p_email))
        AND (
          a.revoked_at IS NOT NULL
          OR a.status IN ('revoked','rejected','banned','suspended','denied','blocked')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.deny_list d
      WHERE d.active IS TRUE
        AND (d.expires_at IS NULL OR d.expires_at > now())
        AND (
          (d.pattern_type = 'email'
             AND lower(d.pattern) = lower(trim(p_email)))
          OR (d.pattern_type = 'email_domain'
             AND lower(split_part(trim(p_email), '@', 2)) = lower(trim(both '@' from d.pattern)))
        )
    );
$function$;
