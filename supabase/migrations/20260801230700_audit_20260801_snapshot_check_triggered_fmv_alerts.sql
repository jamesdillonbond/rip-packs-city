-- Snapshot migration: public.check_triggered_fmv_alerts(integer).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making it UNPINNABLE). Commits the CURRENT LIVE definition verbatim
-- (pg_get_functiondef base64-decoded on 2026-08-01; byte-identical, md5
-- 1605025f5c604aad2dbe3771a4e9d4d2). Applying it is a no-op against prod.
--
-- What it does: the LIVE FMV price-ALERT DETECTOR read by /api/check-alerts (the
-- alert cron -> Telegram/email). It decides which user fmv_alerts fire against the
-- latest FMV + lowest cross-market ask. Load-bearing logic: the active + 6h
-- notification-dedup gate, latest-snapshot-per-edition, lowest positive ask by
-- collection+player+set, the four alert_type trigger rules (price_below /
-- fmv_below / fmv_above / discount_above), and total_active / total_triggered /
-- the p_limit-capped triggered list.

CREATE OR REPLACE FUNCTION public.check_triggered_fmv_alerts(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH active_alerts AS (
    SELECT 
      fa.id as alert_id,
      fa.owner_key,
      fa.edition_key,
      fa.player_name,
      fa.set_name,
      fa.alert_type,
      fa.threshold,
      fa.channel,
      fa.notification_email,
      fa.last_triggered_at,
      fa.collection_id
    FROM fmv_alerts fa
    WHERE fa.active = true
      -- Skip if triggered in last 6h (notification dedup)
      AND (fa.last_triggered_at IS NULL OR fa.last_triggered_at < NOW() - INTERVAL '6 hours')
  ),
  current_prices AS (
    SELECT 
      e.external_id as edition_key,
      e.collection_id,
      fs.fmv_usd,
      fs.confidence,
      cl.ask_price as lowest_ask,
      fs.computed_at
    FROM editions e
    -- FIX 1: LATERAL with LIMIT 1 to get only latest snapshot
    LEFT JOIN LATERAL (
      SELECT fmv_usd, confidence, computed_at FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
      ORDER BY fs2.computed_at DESC LIMIT 1
    ) fs ON true
    -- FIX 2: Use editions text columns directly (works for UFC stubs)
    LEFT JOIN LATERAL (
      SELECT min(cl2.ask_price) as ask_price
      FROM cached_listings cl2
      WHERE cl2.collection_id = e.collection_id
        AND lower(cl2.player_name) = lower(e.player_name)
        AND lower(cl2.set_name) = lower(e.set_name)
        AND cl2.ask_price > 0
    ) cl ON true
    WHERE fs.fmv_usd IS NOT NULL  -- only consider editions that have FMV
  ),
  triggered AS (
    SELECT
      a.alert_id,
      a.owner_key,
      a.edition_key,
      a.player_name,
      a.set_name,
      a.alert_type,
      a.threshold,
      a.channel,
      a.notification_email,
      a.last_triggered_at,
      cp.fmv_usd as current_fmv,
      cp.lowest_ask,
      cp.confidence,
      CASE
        WHEN a.alert_type = 'price_below' AND cp.lowest_ask IS NOT NULL AND cp.lowest_ask <= a.threshold THEN true
        WHEN a.alert_type = 'fmv_below' AND cp.fmv_usd IS NOT NULL AND cp.fmv_usd <= a.threshold THEN true
        WHEN a.alert_type = 'fmv_above' AND cp.fmv_usd IS NOT NULL AND cp.fmv_usd >= a.threshold THEN true
        WHEN a.alert_type = 'discount_above' AND cp.lowest_ask IS NOT NULL AND cp.fmv_usd IS NOT NULL 
             AND cp.fmv_usd > 0 AND ((1 - cp.lowest_ask / cp.fmv_usd) * 100) >= a.threshold THEN true
        ELSE false
      END as is_triggered
    FROM active_alerts a
    LEFT JOIN current_prices cp ON cp.edition_key = a.edition_key AND cp.collection_id = a.collection_id
  )
  SELECT jsonb_build_object(
    'total_active', (SELECT count(*) FROM active_alerts),
    'total_triggered', (SELECT count(*) FROM triggered WHERE is_triggered = true),
    'triggered_alerts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'alert_id', alert_id,
        'owner_key', owner_key,
        'edition_key', edition_key,
        'player_name', player_name,
        'set_name', set_name,
        'alert_type', alert_type,
        'threshold', threshold,
        'current_fmv', current_fmv,
        'lowest_ask', lowest_ask,
        'confidence', confidence,
        'channel', channel,
        'notification_email', notification_email,
        'last_triggered_at', last_triggered_at
      ))
      FROM triggered
      WHERE is_triggered = true
      LIMIT p_limit
    ), '[]'::jsonb)
  );
$function$;
