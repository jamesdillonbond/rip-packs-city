-- 2026-11-14 (Claude Code cloud, ~4:05 PM PT) — alerts review finding #6.
--
-- dispatch_triggered_fmv_alerts scanned `... LIMIT p_max` (200) with NO ORDER BY and no cursor.
-- Past 200 eligible alerts the scan kept taking roughly the same head and every alert outside it
-- was never evaluated, while the run reported ok with scanned: 200. Latent today (0 active alerts,
-- measured 2026-11-14), so this lands before there is volume.
--
-- Fix: fmv_alerts.last_checked_at (new, nullable, written ONLY by this function); the scan orders
-- oldest-checked first (NULLS FIRST), id as a unique tiebreak, and stamps each alert it scans — a
-- rotation that visits N eligible alerts within ceil(N / p_max) ticks. The result gains `eligible`
-- (the count the scan chose from) so a backlog is visible beside `scanned`. Behaviour per alert is
-- unchanged. A partial index on the ORDER BY keys covers the scan.
-- Live body re-read immediately before writing: md5(prosrc) 33c6a1a9c0021412d5b3149e137c1d96
-- = 20261027013447 (the revert file).
-- anon-exec: unchanged (dispatch_triggered_fmv_alerts) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- Revert: re-apply 20261027013447_audit_20261026_pinnacle_fmv_alerts.sql's function; the column and
-- index are inert without it (DROP INDEX / ALTER TABLE ... DROP COLUMN last_checked_at to remove).
ALTER TABLE public.fmv_alerts ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
COMMENT ON COLUMN public.fmv_alerts.last_checked_at IS
  'When dispatch_triggered_fmv_alerts last EVALUATED this alert (its rotation cursor; written only there). Not a delivery time — that is last_triggered_at.';
CREATE INDEX IF NOT EXISTS idx_fmv_alerts_active_last_checked
  ON public.fmv_alerts (last_checked_at ASC NULLS FIRST, id) WHERE active;

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
  v_ch text;
  v_channels text[];
  v_fp text;
  v_prev jsonb;
  v_any_target boolean;
  v_any_new boolean;
  v_enqueued int := 0;
  v_scanned int := 0;
  v_eligible int := 0;
  v_suppressed int := 0;
  v_rearmed int := 0;
  v_bucket text := to_char(date_trunc('hour', now()),'YYYYMMDDHH24');
BEGIN
  -- 2026-11-14: the scan is a ROTATION, not a fixed head. It was `LIMIT p_max`
  -- with no ORDER BY, so past p_max eligible alerts the planner kept handing back
  -- roughly the same rows and the rest were never evaluated, while the run said
  -- ok. Oldest-checked first (never-checked before all), id as the tiebreak, and
  -- every scanned alert is stamped, so N alerts are all visited within
  -- ceil(N / p_max) ticks. `eligible` in the result shows a backlog.
  SELECT count(*) INTO v_eligible
  FROM public.fmv_alerts fa
  WHERE fa.active = true
    AND (fa.last_triggered_at IS NULL OR fa.last_triggered_at < now() - interval '6 hours');

  FOR v_alert IN
    SELECT fa.id, fa.owner_key, fa.edition_key, fa.player_name, fa.set_name,
           fa.alert_type, fa.threshold, fa.channel, fa.notification_email, fa.collection_id,
           fa.armed
    FROM public.fmv_alerts fa
    WHERE fa.active = true
      AND (fa.last_triggered_at IS NULL OR fa.last_triggered_at < now() - interval '6 hours')
    ORDER BY fa.last_checked_at ASC NULLS FIRST, fa.id
    LIMIT p_max
  LOOP
    v_scanned := v_scanned + 1;
    UPDATE public.fmv_alerts SET last_checked_at = now() WHERE id = v_alert.id;

    SELECT fs.fmv_usd, fs.confidence::text INTO v_fmv, v_conf
    FROM public.editions e
    JOIN LATERAL (
      SELECT fmv_usd, confidence FROM public.fmv_snapshots fs2
      WHERE fs2.edition_id = e.id ORDER BY fs2.computed_at DESC LIMIT 1
    ) fs ON true
    WHERE e.external_id = v_alert.edition_key AND e.collection_id = v_alert.collection_id
    LIMIT 1;

    -- 2026-10-10 (#183): the edition's own live ask (edition_live_ask), not
    -- min(cached_listings) matched on player + set NAME. That mixed in other
    -- parallels of the same player and set, and held almost nothing outside Top Shot.
    v_ask := NULL;
    SELECT la.ask INTO v_ask
    FROM public.edition_live_ask(v_alert.collection_id, v_alert.edition_key) la;

    -- 2026-10-26: Disney Pinnacle is priced per PIN in pinnacle_catalog (edition_key = render_id);
    -- it has no `editions` / fmv_snapshots rows, so the two reads above always came back NULL and a
    -- Pinnacle alert could never fire. Its FMV is the catalog's; its ask is the render floor while the
    -- floor map is fresh (48 h on its own sweep stamp) and only when the pin has an FMV and the ask is
    -- <= 3x it — edition_live_ask's rules. TS twin: lib/alerts/pinnacle-ask.ts.
    IF v_alert.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid THEN
      v_fmv := NULL; v_conf := NULL; v_ask := NULL;
      SELECT CASE WHEN pc.fmv_usd > 0 THEN pc.fmv_usd END,
             pc.fmv_confidence::text,
             CASE WHEN pc.fmv_usd > 0 AND pc.floor_ask > 0 AND pc.floor_ask <= pc.fmv_usd * 3
                       AND pc.floor_ask_updated_at > now() - interval '48 hours'
                  THEN pc.floor_ask END
        INTO v_fmv, v_conf, v_ask
        FROM public.pinnacle_catalog pc
       WHERE pc.render_id = v_alert.edition_key;
    END IF;

    v_triggered := CASE
      WHEN v_alert.alert_type = 'price_below'    AND v_ask IS NOT NULL AND v_ask <= v_alert.threshold THEN true
      WHEN v_alert.alert_type = 'fmv_below'      AND v_fmv IS NOT NULL AND v_fmv <= v_alert.threshold THEN true
      WHEN v_alert.alert_type = 'fmv_above'      AND v_fmv IS NOT NULL AND v_fmv >= v_alert.threshold THEN true
      WHEN v_alert.alert_type = 'discount_above' AND v_ask IS NOT NULL AND v_fmv IS NOT NULL AND v_fmv > 0
           AND ((1 - v_ask / v_fmv) * 100) >= v_alert.threshold THEN true
      ELSE false
    END;

    -- 2026-10-14: an alert fires when its condition BECOMES true, not every 6 h
    -- while it stays true (the deal-alert complaint of 10-11, same shape here).
    -- `armed` goes false on a delivery and back to true the first tick the
    -- condition is observed NOT to hold. A read that could not decide (NULL
    -- ask/FMV) evaluates false here too, so it re-arms; that costs at most one
    -- repeat after a data gap, never a missed alert.
    IF NOT v_triggered THEN
      IF NOT v_alert.armed THEN
        UPDATE public.fmv_alerts SET armed = true WHERE id = v_alert.id;
        v_rearmed := v_rearmed + 1;
      END IF;
      CONTINUE;
    END IF;

    -- Still holding since the last delivery. An FMV threshold has nothing new to
    -- say; an ask alert does when the ask itself changed (a new listing / price).
    IF NOT v_alert.armed AND v_alert.alert_type IN ('fmv_below','fmv_above') THEN
      v_suppressed := v_suppressed + 1;
      CONTINUE;
    END IF;
    v_fp := CASE WHEN v_alert.alert_type IN ('price_below','discount_above')
                 THEN 'ask@' || COALESCE(round(v_ask, 2)::text, '')
                 ELSE 'fmv@' || COALESCE(round(v_fmv, 2)::text, '') END;

    -- 'both' is a legal fmv_alerts.channel (the concierge offers it). It used to
    -- resolve no target at all here and was stamped as delivered, silently.
    v_channels := CASE COALESCE(v_alert.channel,'email')
                    WHEN 'both' THEN ARRAY['telegram','email']
                    ELSE ARRAY[COALESCE(v_alert.channel,'email')] END;
    v_any_target := false;
    v_any_new := false;

    FOREACH v_ch IN ARRAY v_channels LOOP
      v_target := NULL;
      SELECT channel_user_id INTO v_target
      FROM public.notification_channels
      WHERE owner_key = v_alert.owner_key AND channel = v_ch
        AND verified = true AND channel_user_id IS NOT NULL
      LIMIT 1;

      IF v_target IS NULL AND v_ch = 'email' THEN
        v_target := v_alert.notification_email;
      END IF;
      IF v_target IS NULL THEN CONTINUE; END IF;
      v_any_target := true;

      IF NOT v_alert.armed THEN
        v_prev := NULL;
        SELECT d.payload INTO v_prev
        FROM public.alert_deliveries d
        WHERE d.owner_key = v_alert.owner_key AND d.channel = v_ch
          AND d.alert_kind = 'fmv' AND d.subject_key = v_alert.id::text
          AND d.status IS DISTINCT FROM 'failed'
        ORDER BY d.created_at DESC
        LIMIT 1;
        IF v_prev IS NOT NULL
           AND 'ask@' || COALESCE(round((v_prev->>'lowest_ask')::numeric, 2)::text, '') = v_fp THEN
          v_suppressed := v_suppressed + 1;
          CONTINUE;
        END IF;
      END IF;

      INSERT INTO public.alert_deliveries
        (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
      VALUES (
        v_alert.owner_key, v_ch, v_target, 'fmv',
        v_alert.id::text, v_bucket || ':' || v_fp,
        jsonb_build_object(
          'alert_id', v_alert.id, 'edition_key', v_alert.edition_key,
          'player_name', v_alert.player_name, 'set_name', v_alert.set_name,
          'alert_type', v_alert.alert_type, 'threshold', v_alert.threshold,
          'current_fmv', v_fmv, 'lowest_ask', v_ask, 'confidence', v_conf
        )
      )
      ON CONFLICT (owner_key, channel, alert_kind, subject_key, dedup_bucket) DO NOTHING;

      IF FOUND THEN
        v_enqueued := v_enqueued + 1;
        v_any_new := true;
      END IF;
    END LOOP;

    IF v_any_new THEN
      UPDATE public.fmv_alerts SET last_triggered_at = now(), armed = false WHERE id = v_alert.id;
    ELSIF NOT v_any_target THEN
      -- Nowhere to send it: stamped so it is retried in 6 h, but left ARMED, so
      -- linking a channel later still gets the user this alert.
      UPDATE public.fmv_alerts SET last_triggered_at = now() WHERE id = v_alert.id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('scanned', v_scanned, 'eligible', v_eligible, 'enqueued', v_enqueued,
    'suppressed_unchanged', v_suppressed, 'rearmed', v_rearmed,
    'bucket', v_bucket, 'ran_at', now());
END;
$function$;
