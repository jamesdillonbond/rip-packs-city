-- DB invariant: public.bump_concierge_ip_rate(text, integer, integer) → jsonb —
-- the per-IP sliding-window rate limiter guarding the paid AI concierge endpoint.
-- Pins: a missing/oversized IP is skipped (fails open, no row); within a window
-- each call increments and allowed flips to false once count exceeds the limit; a
-- call after the window elapsed RESETS the counter to 1 (so a legit IP is never
-- permanently throttled). now() is the transaction timestamp (constant here), so
-- window boundaries are exercised by seeding window_start relative to it.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802184000_audit_20260802_snapshot_bump_concierge_ip_rate.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE concierge_ip_rate (
  ip           text PRIMARY KEY,
  window_start timestamptz,
  count        integer
);

-- >>> BEGIN verbatim bump_concierge_ip_rate (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.bump_concierge_ip_rate(p_ip text, p_limit integer, p_window_secs integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_ip IS NULL OR length(p_ip) = 0 OR length(p_ip) > 100 THEN
    RETURN jsonb_build_object('allowed', true, 'skipped', true);
  END IF;
  INSERT INTO public.concierge_ip_rate AS c (ip, window_start, count)
  VALUES (p_ip, now(), 1)
  ON CONFLICT (ip) DO UPDATE SET
    count = CASE WHEN c.window_start < now() - make_interval(secs => p_window_secs) THEN 1 ELSE c.count + 1 END,
    window_start = CASE WHEN c.window_start < now() - make_interval(secs => p_window_secs) THEN now() ELSE c.window_start END
  RETURNING c.count INTO v_count;
  RETURN jsonb_build_object('allowed', v_count <= p_limit, 'count', v_count);
END;
$function$;
-- <<< END verbatim bump_concierge_ip_rate <<<

-- Missing / empty / oversized IP → skipped (fails open) and writes NO row.
SELECT _assert_eq(bump_concierge_ip_rate(NULL, 3, 60)->>'skipped', 'true', 'NULL ip → skipped');
SELECT _assert_eq(bump_concierge_ip_rate('', 3, 60)->>'skipped', 'true', 'empty ip → skipped');
SELECT _assert_eq(bump_concierge_ip_rate(repeat('x', 101), 3, 60)->>'allowed', 'true', 'oversized ip → allowed (fails open)');
SELECT _assert_eq((SELECT count(*)::text FROM concierge_ip_rate), '0', 'skipped calls wrote no row');

-- Within the window: increment each call; allowed flips false when count exceeds limit (=3).
SELECT _assert_eq(bump_concierge_ip_rate('ip1', 3, 60)->>'count', '1', 'first hit → count 1');
SELECT _assert_eq(bump_concierge_ip_rate('ip1', 3, 60)->>'count', '2', 'second hit → count 2');
SELECT _assert_eq(bump_concierge_ip_rate('ip1', 3, 60)::jsonb->>'allowed', 'true', 'third hit (count 3) still allowed (<= limit)');
SELECT _assert_eq(bump_concierge_ip_rate('ip1', 3, 60)->>'count', '4', 'fourth hit → count 4');
SELECT _assert_eq(bump_concierge_ip_rate('ip1', 3, 60)->>'allowed', 'false', 'over-limit → not allowed');

-- Window elapsed: seed an IP whose window_start is older than the window; the next
-- call RESETS count to 1 (allowed again) — the anti-permanent-throttle invariant.
INSERT INTO concierge_ip_rate (ip, window_start, count) VALUES
  ('ip2', now() - interval '120 seconds', 999);
SELECT _assert_eq(bump_concierge_ip_rate('ip2', 3, 60)->>'count', '1', 'stale window → count reset to 1');
SELECT _assert_eq(bump_concierge_ip_rate('ip2', 3, 60)->>'allowed', 'true', 'after reset → allowed again');
SELECT _assert(( (SELECT window_start FROM concierge_ip_rate WHERE ip='ip2') > now() - interval '60 seconds' ), 'window_start advanced on reset');

SELECT '✓ bump_concierge_ip_rate invariants pass' AS result;
ROLLBACK;
