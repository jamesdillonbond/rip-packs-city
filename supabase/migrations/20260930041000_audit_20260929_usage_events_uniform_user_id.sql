-- 2026-09-29 (PT): usage_events gets ONE identity column for signed-in activity.
--
-- Before: `wallet_address` held three kinds of key — an allow_list wallet (`0x…`) when the
-- signed-in user's email matched an allow_list row, else `user:<auth uuid>`, else `anon`.
-- The same person could therefore appear under two keys (e.g. before/after an allow_list
-- row existed), internal-account exclusion had to match BOTH shapes (a 09-29 read missed
-- the founder because his rows are keyed by wallet), and every "who was on today" report
-- had to re-resolve wallets → emails → accounts by hand.
--
-- After: `user_id` = the Supabase auth uid for EVERY signed-in row (NULL = signed out).
-- `wallet_address` is left exactly as it was — check_feature_quota, /api/admin/beta-activity
-- and /api/admin/resend-welcome-batch all key on it.
--
-- Backfill, measured before applying (60,685 rows, 22 MB):
--   * 636 `user:<uuid>` rows  → the uuid in the key (65 of them name accounts since deleted;
--     the id is still the truthful identity, so NO foreign key — a telemetry insert must
--     never fail because an account was deleted mid-session).
--   * 438 `0x…` rows over 4 wallets → allow_list.wallet_addr → allow_list.email →
--     auth.users.email; each of the 4 resolved to exactly ONE account. The UPDATE only
--     fills a wallet whose resolution is unique, so an ambiguous one stays NULL, not guessed.
--   * 59,611 `anon` rows stay NULL.
--
-- `user_activity` is the uniform read: one row per event with the same person columns for
-- everyone — display_name, email, wallet, is_internal, is_automated. Service-role only
-- (it exposes email).
--
-- Revert:
--   DROP VIEW IF EXISTS public.user_activity;
--   DROP INDEX IF EXISTS public.idx_usage_events_user_time;
--   ALTER TABLE public.usage_events DROP COLUMN IF EXISTS user_id;

ALTER TABLE public.usage_events ADD COLUMN IF NOT EXISTS user_id uuid;

UPDATE public.usage_events
SET user_id = substr(wallet_address, 6)::uuid
WHERE user_id IS NULL
  AND wallet_address ~ '^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

WITH wallet_owner AS (
  SELECT lower(al.wallet_addr) AS wallet, min(u.id::text)::uuid AS user_id
  FROM public.allow_list al
  JOIN auth.users u ON lower(u.email) = lower(al.email)
  WHERE al.wallet_addr IS NOT NULL
  GROUP BY lower(al.wallet_addr)
  HAVING count(DISTINCT u.id) = 1
)
UPDATE public.usage_events e
SET user_id = wo.user_id
FROM wallet_owner wo
WHERE e.user_id IS NULL
  AND e.wallet_address LIKE '0x%'
  AND lower(e.wallet_address) = wo.wallet;

CREATE INDEX IF NOT EXISTS idx_usage_events_user_time
  ON public.usage_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;

CREATE OR REPLACE VIEW public.user_activity
WITH (security_invoker = on) AS
SELECT
  e.id,
  e.occurred_at,
  e.feature_name,
  e.metadata,
  e.user_id,
  (e.user_id IS NOT NULL) AS signed_in,
  CASE
    WHEN e.user_id IS NULL THEN NULL
    WHEN u.id IS NULL THEN '(deleted account)'
    ELSE coalesce(
      nullif(al.username, ''),
      nullif(sw.username, ''),
      CASE WHEN w.wallet IS NOT NULL THEN left(w.wallet, 6) || '…' || right(w.wallet, 4) END,
      split_part(u.email, '@', 1)
    )
  END AS display_name,
  u.email,
  w.wallet,
  (ia.user_id IS NOT NULL) AS is_internal,
  coalesce((e.metadata ->> 'automated')::boolean, false) AS is_automated,
  e.wallet_address AS legacy_key
FROM public.usage_events e
LEFT JOIN auth.users u ON u.id = e.user_id
LEFT JOIN LATERAL (
  SELECT a.username, a.wallet_addr
  FROM public.allow_list a
  WHERE u.email IS NOT NULL AND lower(a.email) = lower(u.email)
  ORDER BY a.created_at DESC NULLS LAST
  LIMIT 1
) al ON true
LEFT JOIN LATERAL (
  SELECT s.username, s.wallet_addr
  FROM public.saved_wallets s
  WHERE s.user_id = e.user_id
  ORDER BY (s.username IS NULL), s.pinned_at DESC NULLS LAST, s.wallet_addr
  LIMIT 1
) sw ON true
LEFT JOIN LATERAL (
  SELECT lower(coalesce(al.wallet_addr, sw.wallet_addr)) AS wallet
) w ON true
LEFT JOIN public.internal_accounts ia ON ia.user_id = e.user_id;

REVOKE ALL ON public.user_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_activity TO service_role;
