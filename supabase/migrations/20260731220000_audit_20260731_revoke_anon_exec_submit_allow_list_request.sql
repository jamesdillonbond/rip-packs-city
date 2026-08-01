-- audit_20260731_revoke_anon_exec_submit_allow_list_request
--
-- submit_allow_list_request was the ONLY writing SECDEF function reachable by
-- `anon` over PostgREST (/rest/v1/rpc/...). Its sole caller is the Next.js
-- route app/api/early-access/submit/route.ts, which invokes it with the
-- SERVICE ROLE (supabaseAdmin) and computes p_ip_hash itself -- so the anon /
-- authenticated grants were unused reachability, not a supported client path.
--
-- Leaving them granted made two guards structurally unenforceable:
--   1. The per-IP rate limit keys on the caller-supplied p_ip_hash and is
--      SKIPPED entirely when it is NULL/empty -- an anon caller omits it (or
--      varies it) for unlimited inserts. The guard is sound only when the key
--      comes from a trusted caller, which is now the case.
--   2. The return value is an existence/status oracle: a known email yields
--      {duplicate:true, status:<status>}, an unknown one {duplicate:false,
--      status:'pending'} -- probeable for any address by anon.
--
-- Revoking fixes both at once with no caller change. Its two siblings on this
-- path (check_email_allowed, auto_approve_eligible) are already anon-revoked;
-- this was the straggler. postgres (owner) + service_role hold explicit grants
-- and are unaffected.
REVOKE EXECUTE ON FUNCTION public.submit_allow_list_request(text, text, text, text[], text, text, text) FROM anon, authenticated;

-- Defensive: a function's default EXECUTE grant is to PUBLIC, which survives a
-- role-level revoke. Not present here (proacl carried explicit anon/auth rows,
-- no PUBLIC entry) so this is a no-op today, but it keeps the revoke total.
REVOKE EXECUTE ON FUNCTION public.submit_allow_list_request(text, text, text, text[], text, text, text) FROM PUBLIC;

-- The fn was carried in the SECDEF anon-exec allowlist as an accepted public
-- write ("baseline 2026-07-20"). That acceptance is now stale: it is no longer
-- anon-executable, so check_secdef_anon_exec_drift() will not flag it and the
-- row would only be dead state for future auditors to re-read.
DELETE FROM public.secdef_anon_exec_allowlist
WHERE identity = 'submit_allow_list_request(text,text,text,text[],text,text,text)';

COMMENT ON FUNCTION public.submit_allow_list_request(text, text, text, text[], text, text, text) IS
  'Early-access signup write path. SERVICE-ROLE ONLY as of 2026-07-31 (audit_20260731_revoke_anon_exec_submit_allow_list_request) -- callable only via app/api/early-access/submit/route.ts using supabaseAdmin. Do NOT re-grant to anon/authenticated: the per-IP rate limit keys on the caller-supplied p_ip_hash (skipped when absent) and the {duplicate,status} return is an existence oracle. Both guards are only sound behind a trusted caller.';
