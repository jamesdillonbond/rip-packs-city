-- DB invariant: public.check_triggered_fmv_alerts(integer) — the LIVE FMV price-
-- ALERT DETECTOR read by /api/check-alerts (the alert cron -> Telegram/email). It
-- decides which user fmv_alerts fire, so a bug here is a missed or spurious user
-- notification. Pinned: the active + 6h notification-dedup gate (both exclude an
-- alert from total_active), latest-snapshot-per-edition, the lowest positive ask
-- by collection+player+set, the FOUR trigger rules (price_below <= / fmv_below <=
-- / fmv_above >= / discount_above (1-ask/fmv)*100 >=), and the total_active /
-- total_triggered / p_limit-capped triggered_alerts shape.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230700_audit_20260801_snapshot_check_triggered_fmv_alerts.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (1605025f5c604aad2dbe3771a4e9d4d2).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE fmv_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY, owner_key text, edition_key text,
  player_name text, set_name text, alert_type text, threshold numeric, channel text,
  notification_email text, last_triggered_at timestamptz, collection_id uuid, active boolean
);
CREATE TABLE editions (id uuid, external_id text, collection_id uuid, player_name text, set_name text);
CREATE TABLE fmv_snapshots (edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE cached_listings (collection_id uuid, player_name text, set_name text, ask_price numeric);

-- >>> BEGIN verbatim check_triggered_fmv_alerts (keep byte-identical to the migration) >>>
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
-- <<< END verbatim check_triggered_fmv_alerts <<<

-- Collection C. ed1 (ek1, Pa/Sa) FMV 50, no listing. ed2 (ek2, Pb/Sb) FMV 100, asks {40,60} -> lowest 40.
INSERT INTO editions (id, external_id, collection_id, player_name, set_name) VALUES
  ('00000000-0000-0000-0000-0000000000e1','ek1','00000000-0000-0000-0000-00000000cccc','Pa','Sa'),
  ('00000000-0000-0000-0000-0000000000e2','ek2','00000000-0000-0000-0000-00000000cccc','Pb','Sb');
INSERT INTO fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 50,'HIGH', now()),
  ('00000000-0000-0000-0000-0000000000e2',100,'HIGH', now());
INSERT INTO cached_listings (collection_id, player_name, set_name, ask_price) VALUES
  ('00000000-0000-0000-0000-00000000cccc','Pb','Sb', 60),
  ('00000000-0000-0000-0000-00000000cccc','Pb','Sb', 40);   -- min(40,60)=40

-- Alerts: A1 fmv_below60 on ek1 -> 50<=60 FIRE; A2 fmv_above200 on ek2 -> 100>=200 no;
-- A3 price_below50 on ek2 -> ask40<=50 FIRE; A4 discount_above50 on ek2 -> (1-40/100)*100=60>=50 FIRE;
-- A5 fmv_below60 on ek1 but last_triggered NOW (within 6h) -> DEDUP out; A6 fmv_below60 ek1 but active=false -> out.
INSERT INTO fmv_alerts (owner_key, edition_key, player_name, set_name, alert_type, threshold, channel, notification_email, last_triggered_at, collection_id, active) VALUES
  ('u1','ek1','Pa','Sa','fmv_below',      60,'email','a@x', NULL,  '00000000-0000-0000-0000-00000000cccc', true),
  ('u1','ek2','Pb','Sb','fmv_above',     200,'email','a@x', NULL,  '00000000-0000-0000-0000-00000000cccc', true),
  ('u1','ek2','Pb','Sb','price_below',    50,'email','a@x', NULL,  '00000000-0000-0000-0000-00000000cccc', true),
  ('u1','ek2','Pb','Sb','discount_above', 50,'email','a@x', NULL,  '00000000-0000-0000-0000-00000000cccc', true),
  ('u1','ek1','Pa','Sa','fmv_below',      60,'email','a@x', now(), '00000000-0000-0000-0000-00000000cccc', true),   -- deduped
  ('u1','ek1','Pa','Sa','fmv_below',      60,'email','a@x', NULL,  '00000000-0000-0000-0000-00000000cccc', false);  -- inactive

-- total_active excludes the deduped + inactive rows (6 rows -> 4 active).
SELECT _assert_eq((check_triggered_fmv_alerts()->>'total_active'), '4', 'active+6h-dedup gate: 4 active (deduped + inactive excluded)');
-- 3 of the 4 fire (A1 fmv_below, A3 price_below, A4 discount_above); A2 fmv_above does not.
SELECT _assert_eq((check_triggered_fmv_alerts()->>'total_triggered'), '3', 'three alerts trigger');
SELECT _assert_eq(jsonb_array_length(check_triggered_fmv_alerts()->'triggered_alerts')::text, '3', 'triggered list has 3');

-- Each trigger rule individually.
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_triggered_fmv_alerts()->'triggered_alerts') e WHERE e->>'alert_type'='fmv_below'),      '1', 'fmv_below fired (fmv 50 <= 60)');
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_triggered_fmv_alerts()->'triggered_alerts') e WHERE e->>'alert_type'='price_below'),    '1', 'price_below fired (ask 40 <= 50)');
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_triggered_fmv_alerts()->'triggered_alerts') e WHERE e->>'alert_type'='discount_above'), '1', 'discount_above fired ((1-40/100)*100=60 >= 50)');
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_triggered_fmv_alerts()->'triggered_alerts') e WHERE e->>'alert_type'='fmv_above'),      '0', 'fmv_above did NOT fire (fmv 100 < 200)');
-- The discount alert carries the lowest ask (40, the min of the two listings), not 60.
SELECT _assert_eq((SELECT (e->>'lowest_ask') FROM jsonb_array_elements(check_triggered_fmv_alerts()->'triggered_alerts') e WHERE e->>'alert_type'='discount_above'), '40', 'discount alert uses the LOWEST positive ask (40, not 60)');

-- ⚠ LATENT BUG, pinned on purpose: p_limit is INEFFECTIVE. The `LIMIT p_limit`
-- sits on the `SELECT jsonb_agg(...) FROM triggered ... LIMIT p_limit` query,
-- but jsonb_agg is an aggregate that already collapses to ONE row, so LIMIT 1
-- limits that single aggregate row, NOT the number of alerts aggregated. The
-- caller (/api/check-alerts, p_limit=100) therefore gets ALL triggered alerts,
-- never a capped slice. Pinned so a future fix (move the LIMIT into a subquery
-- before jsonb_agg) is a conscious change.
SELECT _assert_eq(jsonb_array_length(check_triggered_fmv_alerts(1)->'triggered_alerts')::text, '3', 'p_limit=1 does NOT cap the list (LIMIT-after-aggregate no-op) — returns all 3');
SELECT _assert_eq((check_triggered_fmv_alerts(1)->>'total_triggered'), '3', 'total_triggered unaffected either (still 3)');

SELECT '✓ check_triggered_fmv_alerts invariants pass' AS result;
ROLLBACK;
