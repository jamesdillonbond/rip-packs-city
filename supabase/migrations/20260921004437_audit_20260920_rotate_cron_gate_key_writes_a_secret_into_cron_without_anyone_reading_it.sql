-- audit_20260920_rotate_cron_gate_key_writes_a_secret_into_cron_without_anyone_reading_it
-- anon-exec: rotate_cron_gate_key — NEW function; EXECUTE revoked from PUBLIC, anon, authenticated below.
--
-- WHY. The recorded rotation procedure's step 2 is "SELECT the key OUT of cron.job and paste it into
-- the dashboard secret". That step is, by construction, the one moment a live key exists in plaintext
-- in a console, a clipboard and whatever transcript is recording it — it is how nine keys leaked at
-- once on 2026-08-18. Today the inverse happened: the operator set fresh 40/41-char keys in the
-- secrets store while cron still sends the old 26–28-char ones, so the gate fails closed.
--
-- This function closes the loop from the OTHER side: an edge function, which can already read its own
-- secret, hands the value straight here and this writes it into the cron command. The value never
-- reaches a human, a console or a transcript. Caller gets back only a SHA-256 prefix to verify with.
--
-- ⛔ FORMAT GUARD IS LOAD-BEARING. Three separate placeholder strings were pasted unsubstituted into
-- cron.job during the 2026-08-15 repair (`<TOPSHOT_PACK_SUPPLY_KEY>`, `PASTE_SECRET_VALUE`,
-- `PASTE_THE_REAL_KEY_HERE`) and the 403s stopped, so it LOOKED correct. Anything that is not
-- rpc_pls_ + 16..64 URL-safe chars is rejected. A '&' or a quote would also truncate the rewritten
-- command silently, which the charset class forbids.

CREATE OR REPLACE FUNCTION public.rotate_cron_gate_key(p_jobids integer[], p_new_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_catalog
AS $$
DECLARE
  j        integer;
  updated  integer[] := '{}';
  skipped  jsonb := '[]'::jsonb;
  cmd      text;
  newcmd   text;
BEGIN
  IF p_new_key IS NULL OR p_new_key !~ '^rpc_pls_[A-Za-z0-9_-]{16,64}$' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'key failed the format guard',
      'len', coalesce(length(p_new_key), 0),
      'prefix_ok', coalesce(p_new_key ~ '^rpc_pls_', false));
  END IF;

  FOREACH j IN ARRAY p_jobids LOOP
    SELECT command INTO cmd FROM cron.job WHERE jobid = j;
    IF cmd IS NULL THEN
      skipped := skipped || jsonb_build_object('jobid', j, 'reason', 'no such job');
      CONTINUE;
    END IF;
    IF cmd !~ 'key=[^&'']+' THEN
      skipped := skipped || jsonb_build_object('jobid', j, 'reason', 'command carries no key= parameter');
      CONTINUE;
    END IF;
    newcmd := regexp_replace(cmd, 'key=[^&'']+', 'key=' || p_new_key);
    -- Belt and braces: the rewrite must change exactly the key and nothing else.
    IF regexp_replace(newcmd, 'key=[^&'']+', 'key=X') IS DISTINCT FROM regexp_replace(cmd, 'key=[^&'']+', 'key=X') THEN
      skipped := skipped || jsonb_build_object('jobid', j, 'reason', 'rewrite altered more than the key');
      CONTINUE;
    END IF;
    PERFORM cron.alter_job(j, command := newcmd);
    updated := updated || j;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'updated', updated,
    'skipped', skipped,
    -- Verification handle only. Not reversible, and it is the same digest the diagnostic reports.
    'key_sha12', left(encode(sha256(p_new_key::bytea), 'hex'), 12));
END $$;

REVOKE EXECUTE ON FUNCTION public.rotate_cron_gate_key(integer[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_cron_gate_key(integer[], text) TO postgres, service_role;

COMMENT ON FUNCTION public.rotate_cron_gate_key(integer[], text) IS
'Writes a gate key into the ?key= of the given pg_cron jobs WITHOUT the value passing through a human, a console or a transcript - the caller is an edge function reading its own secret. Returns only a SHA-256 prefix for verification. Format-guarded against unsubstituted placeholders, which have been pasted into cron.job three times and each time looked correct because the 403s stopped.';