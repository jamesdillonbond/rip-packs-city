-- audit_20260922_cron_gate_key_accessor_reads_vault
--
-- STEP 1 OF THE DE-LITERALISE PATH for the pg_cron gate keys (handoff item 5).
--
-- ⚠ THE POPULATION IS 13 JOBS, NOT 4. The 2026-09-22 daytime handoff named jobs
-- 22 / 25 / 27 / 29 and said "25 and 29 share one". Re-derived from `cron.job`
-- the same evening: **13 jobs carry a literal `?key=rpc_pls_…`** — 15, 16, 20,
-- 22, 25, 26, 27, 29, 42, 44, 56, 83, 84 — across **10 distinct keys** and 11
-- distinct edge functions. Fixing the named four would have left nine live
-- literals behind and read as done. (CLAUDE.md: prefer a tree walk over a
-- curated list; a hardcoded allowlist beside a registry goes stale silently.)
--
-- WHY THIS IS WORTH DOING AT ALL. The key is not a user-facing secret and anyone
-- who can read `cron.job` already has the database. The leak surface is the
-- TRANSCRIPT: CLAUDE.md records that `get_edge_function` and `cron.job.command`
-- hand back live gate keys, and the memory store records two separate occasions
-- where a secret-bearing surface was read into a session log. Removing the
-- literal removes that surface for every future session, permanently.
--
-- THE SHARING IS PER EDGE FUNCTION, not per job: 15/16 share
-- `backfill-topshot-pack-supply`, 83/84 share `ingest-pinnacle-mints`. Jobs 25
-- and 29 happen to share one key across TWO different functions, so the secret
-- is keyed on the function name and that one value is simply stored twice.
-- Keying on the function (not the job id) means re-pointing a job at another
-- function cannot silently carry the wrong key.
--
-- ⛔ THE ACCESSOR RAISES, IT NEVER RETURNS NULL. A NULL here would concatenate
-- into a NULL url and `net.http_get(NULL)` would fail somewhere further away
-- with a worse message; worse, a future caller wrapping this in COALESCE would
-- publish a silent unauthenticated call. CLAUDE.md names the shape: an unwrapper
-- that RETURNS on failure leaves every downstream catch dead.
--
-- ⚠ GRANT AND REVOKE IN THE SAME MIGRATION. CLAUDE.md: revoking FROM PUBLIC,
-- anon, authenticated in one statement ORPHANS a pg_cron caller. All 13 jobs run
-- as `postgres` (verified: `cron.job.username`), so postgres is granted back
-- explicitly rather than relying on ownership.
--
-- The vault secrets themselves were created out-of-band (they carry the live key
-- values and so CANNOT appear in a migration file). Verified before this ships:
-- for all 13 jobs, `vault.decrypted_secrets.decrypted_secret` equals the literal
-- currently in `cron.job.command` — 13 of 13 true.
--
-- STEP 2 (separate migration) rewrites the commands to call this function.
--
-- REVERT: DROP FUNCTION public.cron_gate_key(text);  -- safe while no command
-- references it. Once step 2 has shipped, revert step 2 first.

CREATE OR REPLACE FUNCTION public.cron_gate_key(p_fn text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'pg_catalog'
AS $fn$
DECLARE
  v_key text;
BEGIN
  -- Bound the name before it reaches a lookup: this value comes from a cron
  -- command, and a junk name should fail here rather than miss the row and be
  -- mistaken for "no secret configured".
  IF p_fn IS NULL OR p_fn !~ '^[a-zA-Z0-9_-]{1,100}$' THEN
    RAISE EXCEPTION 'cron_gate_key: bad edge function name';
  END IF;

  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'cron_gate_key__' || p_fn;

  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'cron_gate_key: no vault secret named cron_gate_key__%', p_fn;
  END IF;

  RETURN v_key;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.cron_gate_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_gate_key(text) TO postgres;

DO $assert$
BEGIN
  IF has_function_privilege('anon', 'public.cron_gate_key(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute cron_gate_key';
  END IF;
  IF has_function_privilege('authenticated', 'public.cron_gate_key(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute cron_gate_key';
  END IF;
  IF NOT has_function_privilege('postgres', 'public.cron_gate_key(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postgres (the pg_cron job owner) cannot execute cron_gate_key';
  END IF;
END
$assert$;
