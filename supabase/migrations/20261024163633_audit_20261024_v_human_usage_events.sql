-- audit_20261024_v_human_usage_events — usage_events with the robots and the team taken out.
--
-- WHY. The 2026-10-24 user-activity read (Trevor's handoff, 10-10 → 10-24 PT) found ~99% of the
-- 58.8k anonymous page views were automated QA (Playwright alone 53.5k), and the founder wallet
-- 0xbd94cade097e50ac logs concierge_messages with NO user_id — so a human-activity question needed
-- the same three filters hand-typed every time, and a forgotten one inflated the answer ~100×.
--
-- WHAT. A read-only view, security_invoker (it runs with the CALLER's rights, so anon and
-- authenticated — which cannot read usage_events — read nothing through it), excluding:
--   1. rows a browser automation stamped (metadata.automated_by set, or metadata.automated = true);
--   2. rows whose user_id is in internal_accounts;
--   3. rows whose wallet_address belongs to an internal account — via saved_wallets.user_id or the
--      allow_list email ↔ auth.users — or is the `user:<id>` form of one.
-- It is a FILTER, not a census: an automation that stamps nothing still counts as human.
--
-- Revert: DROP VIEW public.v_human_usage_events;

CREATE OR REPLACE VIEW public.v_human_usage_events
WITH (security_invoker = on) AS
WITH internal_users AS (
  SELECT ia.user_id FROM public.internal_accounts ia
),
internal_wallets AS (
  SELECT lower(sw.wallet_addr) AS w FROM public.saved_wallets sw
  WHERE sw.user_id IN (SELECT user_id FROM internal_users) AND sw.wallet_addr IS NOT NULL
  UNION
  SELECT lower(al.wallet_addr) FROM public.allow_list al
  JOIN auth.users u ON lower(u.email) = lower(al.email)
  WHERE u.id IN (SELECT user_id FROM internal_users) AND al.wallet_addr IS NOT NULL
  UNION
  SELECT 'user:' || iu.user_id::text FROM internal_users iu
)
SELECT e.*
FROM public.usage_events e
WHERE e.metadata->>'automated_by' IS NULL
  AND COALESCE(lower(e.metadata->>'automated') IN ('true', '1', 'yes'), false) = false
  AND (e.user_id IS NULL OR e.user_id NOT IN (SELECT user_id FROM internal_users))
  AND (e.wallet_address IS NULL OR lower(e.wallet_address) NOT IN (SELECT w FROM internal_wallets));

COMMENT ON VIEW public.v_human_usage_events IS
  'usage_events minus automation-stamped rows and internal accounts (by user_id and by wallet). A filter, not a census. 2026-10-24.';

REVOKE ALL ON public.v_human_usage_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_human_usage_events TO service_role;
