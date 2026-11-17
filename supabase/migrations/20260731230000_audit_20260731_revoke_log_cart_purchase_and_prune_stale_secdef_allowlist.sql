-- audit_20260731_revoke_log_cart_purchase_and_prune_stale_secdef_allowlist
--
-- Follow-on cleanup to audit_20260731_revoke_anon_exec_submit_allow_list_request.
-- Two issues found by auditing the SECDEF exec surface + its allowlist.

-- (1) log_cart_purchase(jsonb): an `authenticated`-executable WRITE with ZERO
-- callers. The round-6 handoff scoped its "exactly one writes" check to the
-- anon-35, so this authenticated-only writer was never examined. It is dead and
-- spoofable: buyer_address is a plain parameter with no ownership check, so any
-- authenticated user could log purchase rows attributing activity to any
-- address. Cart is SHELVED (Known issues #1) and /api/cart is no longer public;
-- the single route that writes this table (app/api/cart/record/route.ts) does a
-- direct service-role .from('cart_purchase_log').insert() and never calls this
-- RPC. cart_purchase_log holds 0 rows -- it has never been written.
-- Function is KEPT (Cart is revivable), only the client grants are dropped.
REVOKE EXECUTE ON FUNCTION public.log_cart_purchase(jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_cart_purchase(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION public.log_cart_purchase(jsonb) IS
  'Cart purchase logger. SERVICE-ROLE ONLY as of 2026-07-31 (audit_20260731_revoke_log_cart_purchase_and_prune_stale_secdef_allowlist). Zero callers -- Cart is shelved and app/api/cart/record writes cart_purchase_log directly with the service role. Do NOT re-grant to anon/authenticated: buyer_address is caller-supplied with no ownership check, so a client grant makes purchase attribution spoofable.';

-- (2) Prune stale allowlist rows. Both functions were revoked in earlier
-- passes but their acceptance rows were never removed, so they were dead state
-- that every future auditor of this table has to re-read and re-confirm:
--   get_allday_listing_serial_targets -- revoked 2026-07-25
--     (audit_20260725_revoke_anon_exec_allday_listing_serial_targets)
--   sentinel_fmv_confidence_rows      -- revoked after being flagged as drift
--     in docs/handoff-2026-07-26-db-saturation-and-allday-resolver.md
-- check_secdef_anon_exec_drift() only flags functions that ARE anon/auth
-- executable, so removing a grant is what clears it -- the allowlist row is
-- then pure residue. Same reasoning retires log_cart_purchase's row above.
DELETE FROM public.secdef_anon_exec_allowlist
WHERE identity IN (
  'log_cart_purchase(jsonb)',
  'get_allday_listing_serial_targets(integer,boolean,integer)',
  'sentinel_fmv_confidence_rows(uuid)'
);

-- DELIBERATELY NOT TOUCHED: save_fast_break_lineup(...) is the one remaining
-- anon/auth-executable SECDEF writer, and it is CORRECT as written -- it opens
-- with `IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE
-- forbidden_cross_user`, and only `authenticated` (never anon) can reach it, so
-- a JWT-bearing caller can only write its own lineup. Fast Break is a live
-- feature with a legitimate authenticated client path. Leave the grant.
