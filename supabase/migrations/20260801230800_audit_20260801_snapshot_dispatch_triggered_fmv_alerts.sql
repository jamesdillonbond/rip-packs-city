-- Snapshot migration: public.dispatch_triggered_fmv_alerts(integer).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). Commits the CURRENT LIVE definition verbatim
-- (pg_get_functiondef base64-decoded 2026-08-01; byte-identical, md5
-- 2b37a1f183501a84545f4c7b16745012). Applying it is a no-op against prod.
--
-- What it does: the SEND side of the FMV price-alert pair (called from
-- lib/alerts.ts). It scans active, non-6h-deduped alerts, re-evaluates the four
-- trigger rules, resolves a delivery target (verified notification_channel, else
-- the email fallback for email-channel alerts), enqueues an alert_deliveries row
-- under an hourly dedup bucket (ON CONFLICT DO NOTHING), and stamps
-- last_triggered_at. A triggered-but-targetless alert is stamped (so it dedups)
-- but never enqueued; a non-triggered alert is skipped untouched.

CREATE OR REPLACE FUNCTION public.dispatch_triggered_fmv_alerts(p_max integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_alert record;
  v_fmv numeric;
  v_ask numeric;
  v_conf text;
  v_triggered boolean;
  v_target text;
  v_enqueued int := 0;
  v_scanned int := 0;
  v_bucket text := to_char(date_trunc('hour', now()),'YYYYMMDDHH24');
BEGIN
  FOR v_alert IN
    SELECT fa.id, fa.owner_key, fa.edition_key, fa.player_name, fa.set_name,
           fa.alert_type, fa.threshold, fa.channel, fa.notification_email, fa.collection_id
    FROM public.fmv_alerts fa
    WHERE fa.active = true
      AND (fa.last_triggered_at IS NULL OR fa.last_triggered_at < now() - interval '6 hours')
    LIMIT p_max
  LOOP
    v_scanned := v_scanned + 1;

    SELECT fs.fmv_usd, fs.confidence::text INTO v_fmv, v_conf
    FROM public.editions e
    JOIN LATERAL (
      SELECT fmv_usd, confidence FROM public.fmv_snapshots fs2
      WHERE fs2.edition_id = e.id ORDER BY fs2.computed_at DESC LIMIT 1
    ) fs ON true
    WHERE e.external_id = v_alert.edition_key AND e.collection_id = v_alert.collection_id
    LIMIT 1;

    SELECT min(cl.ask_price) INTO v_ask
    FROM public.cached_listings cl
    JOIN public.editions e ON e.collection_id = cl.collection_id
      AND lower(e.player_name) = lower(cl.player_name)
      AND lower(e.set_name) = lower(cl.set_name)
    WHERE e.external_id = v_alert.edition_key AND e.collection_id = v_alert.collection_id
      AND cl.ask_price > 0;

    v_triggered := CASE
      WHEN v_alert.alert_type = 'price_below'    AND v_ask IS NOT NULL AND v_ask <= v_alert.threshold THEN true
      WHEN v_alert.alert_type = 'fmv_below'      AND v_fmv IS NOT NULL AND v_fmv <= v_alert.threshold THEN true
      WHEN v_alert.alert_type = 'fmv_above'      AND v_fmv IS NOT NULL AND v_fmv >= v_alert.threshold THEN true
      WHEN v_alert.alert_type = 'discount_above' AND v_ask IS NOT NULL AND v_fmv IS NOT NULL AND v_fmv > 0
           AND ((1 - v_ask / v_fmv) * 100) >= v_alert.threshold THEN true
      ELSE false
    END;

    IF NOT v_triggered THEN CONTINUE; END IF;

    SELECT channel_user_id INTO v_target
    FROM public.notification_channels
    WHERE owner_key = v_alert.owner_key AND channel = COALESCE(v_alert.channel,'email')
      AND verified = true AND channel_user_id IS NOT NULL
    LIMIT 1;

    IF v_target IS NULL AND COALESCE(v_alert.channel,'email') = 'email' THEN
      v_target := v_alert.notification_email;
    END IF;

    IF v_target IS NULL THEN
      UPDATE public.fmv_alerts SET last_triggered_at = now() WHERE id = v_alert.id;
      CONTINUE;
    END IF;

    INSERT INTO public.alert_deliveries
      (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
    VALUES (
      v_alert.owner_key, COALESCE(v_alert.channel,'email'), v_target, 'fmv',
      v_alert.id::text, v_bucket,
      jsonb_build_object(
        'alert_id', v_alert.id, 'edition_key', v_alert.edition_key,
        'player_name', v_alert.player_name, 'set_name', v_alert.set_name,
        'alert_type', v_alert.alert_type, 'threshold', v_alert.threshold,
        'current_fmv', v_fmv, 'lowest_ask', v_ask, 'confidence', v_conf
      )
    )
    ON CONFLICT (owner_key, channel, alert_kind, subject_key, dedup_bucket) DO NOTHING;

    IF FOUND THEN v_enqueued := v_enqueued + 1; END IF;
    UPDATE public.fmv_alerts SET last_triggered_at = now() WHERE id = v_alert.id;
  END LOOP;

  RETURN jsonb_build_object('scanned', v_scanned, 'enqueued', v_enqueued, 'bucket', v_bucket, 'ran_at', now());
END;
$function$;
