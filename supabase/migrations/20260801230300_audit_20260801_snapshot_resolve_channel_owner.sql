-- Snapshot migration: public.resolve_channel_owner(text,text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). This commits the CURRENT LIVE definition verbatim
-- (pulled via pg_get_functiondef on 2026-08-01) so it can carry a pinned
-- invariant test. Applying it is a no-op against prod (byte-identical).
--
-- What it does: resolves an inbound notification channel (Telegram/Discord user)
-- to the RPC account that owns it — the routing + trust boundary for channel
-- commands. Load-bearing SECURITY property: it resolves an owner ONLY for a row
-- with verified = true (an unverified channel link must return linked:false and
-- never surface an owner_key), keyed on (channel, channel_user_id); a successful
-- resolution stamps last_used_at.

CREATE OR REPLACE FUNCTION public.resolve_channel_owner(p_channel text, p_channel_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner text;
BEGIN
  SELECT owner_key INTO v_owner FROM public.notification_channels
  WHERE channel = p_channel AND channel_user_id = p_channel_user_id AND verified = true;

  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('linked', false);
  END IF;

  UPDATE public.notification_channels
  SET last_used_at = now()
  WHERE channel = p_channel AND channel_user_id = p_channel_user_id;

  RETURN jsonb_build_object('linked', true, 'owner_key', v_owner);
END;
$function$;
