-- DB invariant: public.dispatch_triggered_fmv_alerts(integer) -- the SEND side of
-- the FMV price-alert pair (called from lib/alerts.ts). It scans active,
-- non-6h-deduped alerts, re-evaluates the four trigger rules, resolves a delivery
-- target, enqueues an alert_deliveries row under an hourly dedup bucket, and
-- stamps last_triggered_at. Pinned: target resolution (verified channel > email
-- fallback), the enqueue + hourly ON CONFLICT dedup, the triggered-but-targetless
-- path (stamped, not enqueued), the non-triggered skip (untouched), the scanned/
-- enqueued accounting, and the last_triggered 6h re-scan dedup.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230800_audit_20260801_snapshot_dispatch_triggered_fmv_alerts.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (2b37a1f183501a84545f4c7b16745012).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE fmv_alerts (id bigint GENERATED ALWAYS AS IDENTITY, owner_key text, edition_key text, player_name text, set_name text, alert_type text, threshold numeric, channel text, notification_email text, last_triggered_at timestamptz, collection_id uuid, active boolean);
CREATE TABLE editions (id uuid, external_id text, collection_id uuid, player_name text, set_name text);
CREATE TABLE fmv_snapshots (edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE cached_listings (collection_id uuid, player_name text, set_name text, ask_price numeric);
CREATE TABLE notification_channels (owner_key text, channel text, channel_user_id text, verified boolean);
CREATE TABLE alert_deliveries (owner_key text, channel text, channel_user_id text, alert_kind text, subject_key text, dedup_bucket text, payload jsonb, UNIQUE(owner_key, channel, alert_kind, subject_key, dedup_bucket));

-- >>> BEGIN verbatim dispatch_triggered_fmv_alerts (keep byte-identical to the migration) >>>
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
-- <<< END verbatim dispatch_triggered_fmv_alerts <<<

INSERT INTO editions (id, external_id, collection_id, player_name, set_name) VALUES
  ('00000000-0000-0000-0000-0000000000e1','ek1','00000000-0000-0000-0000-00000000cccc','Pa','Sa'),
  ('00000000-0000-0000-0000-0000000000e2','ek2','00000000-0000-0000-0000-00000000cccc','Pb','Sb');
INSERT INTO fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 50,'HIGH', now()),
  ('00000000-0000-0000-0000-0000000000e2',100,'HIGH', now());
INSERT INTO cached_listings (collection_id, player_name, set_name, ask_price) VALUES
  ('00000000-0000-0000-0000-00000000cccc','Pb','Sb', 40);
INSERT INTO notification_channels (owner_key, channel, channel_user_id, verified) VALUES
  ('u1','telegram','tg1', true);

-- A1(id1) fmv_below60/ek1 u1 telegram -> triggered, verified channel tg1 -> ENQUEUE.
-- A2(id2) fmv_above200/ek2 u1 -> NOT triggered -> skipped untouched.
-- A3(id3) price_below50/ek2 u2 email -> triggered, no channel -> EMAIL FALLBACK b@x -> ENQUEUE.
-- A4(id4) fmv_below60/ek1 u3 telegram, no email -> triggered, no target -> stamp only, no enqueue.
INSERT INTO fmv_alerts (owner_key, edition_key, player_name, set_name, alert_type, threshold, channel, notification_email, last_triggered_at, collection_id, active) VALUES
  ('u1','ek1','Pa','Sa','fmv_below',   60,'telegram', 'a@x', NULL, '00000000-0000-0000-0000-00000000cccc', true),
  ('u1','ek2','Pb','Sb','fmv_above',  200,'telegram', 'a@x', NULL, '00000000-0000-0000-0000-00000000cccc', true),
  ('u2','ek2','Pb','Sb','price_below', 50,'email',    'b@x', NULL, '00000000-0000-0000-0000-00000000cccc', true),
  ('u3','ek1','Pa','Sa','fmv_below',   60,'telegram', NULL,  NULL, '00000000-0000-0000-0000-00000000cccc', true);

-- FIRST RUN (call once, capture the jsonb return).
CREATE TEMP TABLE d1 AS SELECT dispatch_triggered_fmv_alerts() AS j;
SELECT _assert_eq((SELECT (j->>'scanned')  FROM d1), '4', 'first run scans all 4 active alerts');
SELECT _assert_eq((SELECT (j->>'enqueued') FROM d1), '2', 'first run enqueues 2 deliveries (A1 channel, A3 email fallback)');
SELECT _assert_eq((SELECT count(*)::text FROM alert_deliveries), '2', 'exactly 2 delivery rows written');
SELECT _assert_eq((SELECT channel_user_id FROM alert_deliveries WHERE owner_key='u1'), 'tg1', 'A1 delivered to the verified channel target');
SELECT _assert_eq((SELECT channel_user_id FROM alert_deliveries WHERE owner_key='u2'), 'b@x', 'A3 delivered via the email fallback (no verified channel)');
-- A2 not triggered -> untouched (last_triggered still NULL).
SELECT _assert_eq((SELECT (last_triggered_at IS NULL)::text FROM fmv_alerts WHERE id=2), 'true', 'a non-triggered alert is left untouched');
-- A4 triggered-but-targetless -> stamped (so it dedups) but NOT enqueued.
SELECT _assert_eq((SELECT (last_triggered_at IS NOT NULL)::text FROM fmv_alerts WHERE id=4), 'true', 'a triggered-but-targetless alert is stamped');
SELECT _assert_eq((SELECT count(*)::text FROM alert_deliveries WHERE owner_key='u3'), '0', 'a targetless alert enqueues nothing');
-- A1/A3 stamped.
SELECT _assert_eq((SELECT (bool_and(last_triggered_at IS NOT NULL))::text FROM fmv_alerts WHERE id IN (1,3)), 'true', 'enqueued alerts are stamped');

-- SECOND RUN: A1/A3/A4 now within the 6h dedup window -> excluded; only A2 (unstamped) rescanned, still not triggered.
CREATE TEMP TABLE d2 AS SELECT dispatch_triggered_fmv_alerts() AS j;
SELECT _assert_eq((SELECT (j->>'scanned')  FROM d2), '1', 'second run rescans only the unstamped non-triggered A2');
SELECT _assert_eq((SELECT (j->>'enqueued') FROM d2), '0', 'second run enqueues nothing (6h dedup)');

-- HOURLY-BUCKET DEDUP: clear A1's stamp to make it re-eligible; the delivery for
-- this hour already exists, so ON CONFLICT DO NOTHING must NOT re-enqueue.
UPDATE fmv_alerts SET last_triggered_at = NULL WHERE id = 1;
CREATE TEMP TABLE d3 AS SELECT dispatch_triggered_fmv_alerts() AS j;
SELECT _assert_eq((SELECT (j->>'enqueued') FROM d3), '0', 'same-hour re-eligible alert does NOT double-deliver (bucket ON CONFLICT)');
SELECT _assert_eq((SELECT count(*)::text FROM alert_deliveries), '2', 'still exactly 2 deliveries (no duplicate row)');

SELECT '✓ dispatch_triggered_fmv_alerts invariants pass' AS result;
ROLLBACK;
