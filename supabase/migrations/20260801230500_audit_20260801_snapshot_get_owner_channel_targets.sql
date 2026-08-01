-- Snapshot migration: public.get_owner_channel_targets(text,text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: the send-side of the channel-routing pair with
-- resolve_channel_owner — given an RPC owner it returns the notification targets
-- (Telegram/Discord) an alert should be delivered to. Load-bearing SECURITY
-- property: it returns ONLY verified = true channels with a non-null
-- channel_user_id (never an unverified or half-linked channel), scoped to the
-- owner, optionally narrowed to one channel; empty resolves to '[]' (never NULL).

CREATE OR REPLACE FUNCTION public.get_owner_channel_targets(p_owner_key text, p_channel text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'channel', channel,
           'channel_user_id', channel_user_id,
           'channel_username', channel_username
         )), '[]'::jsonb)
  FROM public.notification_channels
  WHERE owner_key = p_owner_key
    AND verified = true
    AND channel_user_id IS NOT NULL
    AND (p_channel IS NULL OR channel = p_channel);
$function$;
