-- audit_20261010_fmv_alerts_read_the_editions_own_live_ask
--
-- 2026-10-10 ~7:45 AM PT (Claude Code cloud; Trevor: "Keep going"). Closes known-issues #183.
--
-- MEASURED. Both FMV-alert functions took the ASK as min(cached_listings.ask_price) joined to the
-- edition on collection + lower(player_name) + lower(set_name):
--   * dispatch_triggered_fmv_alerts (lib/alerts.ts -> /api/cron/alerts-dispatch)
--   * check_triggered_fmv_alerts   (/api/check-alerts; ~4,200 calls in pg_stat_statements)
-- Two defects. (1) cached_listings holds 40,439 Top Shot rows and ~100 each for All Day and
-- Golazos (Flowty, dormant since 05-14), and none for Pinnacle / UFC / Candy, so price_below and
-- discount_above could almost never fire outside Top Shot. (2) Even on Top Shot the NAME match is
-- not an edition match: every parallel of a player + set shares those names, so an edition's
-- "lowest ask" could be a cheaper printing's ask, and a discount alert could fire on it.
-- Latent: 0 fmv_alerts rows exist (re-read 10-10), so nobody has been notified wrongly.
--
-- CHANGE. New public.edition_live_ask(collection_id, edition_key): the SQL twin of
-- lib/asks/edition-live-ask.ts (the rule /api/best-asks and the checklist use): All Day
-- ghost-filtered floor / Candy confirmed floor, then edition_offers seen <= 7 d, then
-- badge_editions <= 7 d, and only when the edition has an FMV and the ask is <= 3x it. Prototype
-- read 10-10 on prod: Top Shot 58:1972 / 171:6546 / 135:4722 -> edition_offers; All Day 2835 /
-- 2901 / 1248 -> allday_floor; Candy junior-caminero-pink / paul-skenes-green ->
-- candy_confirmed_floor, yoshinobu-yamamoto -> none (its only ask is > 3x FMV, the troll shape).
-- Both alert functions now read it. check_triggered_fmv_alerts is priced PER ALERT instead of per
-- edition (it used to build current_prices for every edition with an FMV and join alerts after).
-- Everything else is unchanged, including check_triggered's pinned p_limit no-op.
-- Golazos has 26 fresh asks and Pinnacle / UFC none in these sources, so a price alert there does
-- not fire: an honest absence, not a wrong ask.
--
-- anon-exec: revoked (edition_live_ask) -- new function; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: unchanged (dispatch_triggered_fmv_alerts) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-10).
-- anon-exec: unchanged (check_triggered_fmv_alerts) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-10).
--
-- Base verified 2026-10-10: live prosrc md5 (whitespace-normalised) dispatch 3262f4d4333ec2cb093aa07b087741ba
-- and check 82f567922ed948a95961e42906aca76f = their pins' verbatim blocks (20260801230800 / 20260801230700).
--
-- REVERT: re-apply the dispatch_triggered_fmv_alerts block of 20260801230800_… and the
-- check_triggered_fmv_alerts block of 20260801230700_… verbatim, then
-- DROP FUNCTION public.edition_live_ask(uuid, text);

CREATE OR REPLACE FUNCTION public.edition_live_ask(p_collection_id uuid, p_edition_key text)
 RETURNS TABLE(ask numeric, source text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The LIVE low ask of ONE edition: what a buyer would pay now. The SQL twin of
  -- lib/asks/edition-live-ask.ts (resolveLiveAsks); keep the two rules identical.
  --   priority 1: allday_edition_floor_ask (ghost listings excluded) / candy_listing_floor.confirmed_floor_usd
  --   priority 2: edition_offers.low_ask last SEEN (low_ask_confirmed_at) within 7 days
  --   priority 3: badge_editions.low_ask updated within 7 days
  -- An ask is returned only when the edition has an FMV and the ask is <= 3x it
  -- (the estate's disconnected-ask multiple). No row = no usable ask, never 0.
  WITH ed AS (
    SELECT e.id FROM public.editions e
     WHERE e.collection_id = p_collection_id AND e.external_id = p_edition_key
     LIMIT 1
  ), fmv AS (
    SELECT f.fmv_usd FROM public.edition_fmv_current f JOIN ed ON f.edition_id = ed.id
     WHERE f.fmv_usd > 0
  ), cand AS (
    SELECT a.floor_ask AS ask, 'allday_floor'::text AS source, 1 AS pri
      FROM public.allday_edition_floor_ask a JOIN ed ON a.edition_id = ed.id
    UNION ALL
    SELECT c.confirmed_floor_usd, 'candy_confirmed_floor', 1
      FROM public.candy_listing_floor c JOIN ed ON c.edition_id = ed.id
    UNION ALL
    SELECT o.low_ask, 'edition_offers', 2
      FROM public.edition_offers o
     WHERE o.collection_id = p_collection_id AND o.external_id = p_edition_key
       AND o.low_ask_confirmed_at > now() - interval '7 days'
    UNION ALL
    SELECT b.low_ask, 'badge_editions', 3
      FROM public.badge_editions b
     WHERE b.collection_id = p_collection_id AND b.external_id = p_edition_key
       AND b.updated_at > now() - interval '7 days'
  )
  SELECT cand.ask, cand.source
    FROM cand CROSS JOIN fmv
   WHERE cand.ask > 0 AND cand.ask <= fmv.fmv_usd * 3
   ORDER BY cand.pri, cand.ask
   LIMIT 1;
$function$;

REVOKE EXECUTE ON FUNCTION public.edition_live_ask(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edition_live_ask(uuid, text) TO postgres, service_role;

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

    -- 2026-10-10 (#183): the edition's own live ask (edition_live_ask), not
    -- min(cached_listings) matched on player + set NAME. That mixed in other
    -- parallels of the same player and set, and held almost nothing outside Top Shot.
    v_ask := NULL;
    SELECT la.ask INTO v_ask
    FROM public.edition_live_ask(v_alert.collection_id, v_alert.edition_key) la;

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
  -- 2026-10-10 (#183): priced PER ALERT, not per edition. The ask is the edition's
  -- own live ask (edition_live_ask: All Day ghost-filtered floor / Candy confirmed
  -- floor / edition_offers seen <= 7 d / badge_editions <= 7 d, only when <= 3x FMV).
  -- It used to be min(cached_listings) matched on player + set NAME, which mixed
  -- in other parallels of the same player and set and held almost nothing outside
  -- Top Shot. Driving from the alerts also stops the lateral running per edition.
  current_prices AS (
    SELECT
      a.alert_id,
      fs.fmv_usd,
      fs.confidence,
      la.ask as lowest_ask,
      fs.computed_at
    FROM active_alerts a
    JOIN editions e ON e.external_id = a.edition_key AND e.collection_id = a.collection_id
    -- FIX 1: LATERAL with LIMIT 1 to get only latest snapshot
    LEFT JOIN LATERAL (
      SELECT fmv_usd, confidence, computed_at FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
      ORDER BY fs2.computed_at DESC LIMIT 1
    ) fs ON true
    LEFT JOIN LATERAL public.edition_live_ask(a.collection_id, a.edition_key) la ON true
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
    LEFT JOIN current_prices cp ON cp.alert_id = a.alert_id
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
