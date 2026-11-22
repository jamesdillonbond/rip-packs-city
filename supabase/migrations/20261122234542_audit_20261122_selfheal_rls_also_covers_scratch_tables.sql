-- audit_20261122_selfheal_rls_also_covers_scratch_tables — 2026-11-22 ~3:55 PM PT (Claude Code cloud, autonomous pass).
--
-- WHY. A `scratch_*` table created in public by an ad-hoc execute_sql lands with RLS OFF and the default anon
-- grants, so PostgREST serves it to anyone. It has now happened at least four times with scratch-named tables:
-- 10-03 `scratch_flip_probe` (one wallet's NFT ids + transactions), 10-19, and 11-22 `scratch_backfill_pk_trevor`
-- (one owner's pack buy/rip/sell history; smoke test red ~3:13–3:30 PM PT, closed by 20261122232956).
-- The migration-side guard (__tests__/migration-new-public-table-enables-rls.test.ts) cannot see these: they are
-- never in a migration. selfheal_audit_table_rls() (pg_cron 232, `47 * * * *`) already applies exactly this policy
-- to `audit_%`. By the documented convention (docs/reference/database.md) a scratch table must never be public.
--
-- WHAT. Same function, same body, one predicate widened: `audit\_%` OR `scratch\_%`. RLS on + anon/authenticated
-- revoked; owner and service_role bypass RLS, so the scratch user is unaffected. NOT widened to `_%`: three
-- `_cohort_*` / `_rpc_waste_*` tables carry deliberate anon grants. No new cron job; schedule unchanged.
-- The event-trigger alternative (all new tables) stays Trevor's call (handoff-2026-11-22-daytime item 7).
--
-- anon-exec: unchanged (selfheal_audit_table_rls) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- REVERT: re-apply this body with the `OR c.relname LIKE 'scratch\_%'` line removed.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.selfheal_audit_table_rls()'::regprocedure)
     IS DISTINCT FROM 'ce171f7ce03c1ee0e04744bd414532aa' THEN
    RAISE EXCEPTION 'selfheal_audit_table_rls live body drifted; re-read it and re-base';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.selfheal_audit_table_rls()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  t          record;
  v_rls      text[] := '{}';
  v_revoked  text[] := '{}';
BEGIN
  FOR t IN
    SELECT c.oid, c.relname, c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND (c.relname LIKE 'audit\_%'
           OR c.relname LIKE 'scratch\_%')  -- 2026-11-22: ad-hoc scratch tables (see header)
  LOOP
    IF NOT t.relrowsecurity THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
      v_rls := v_rls || t.relname;
    END IF;

    IF has_table_privilege('anon', t.oid, 'SELECT')
       OR has_table_privilege('authenticated', t.oid, 'SELECT') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.relname);
      v_revoked := v_revoked || t.relname;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'rls_enabled_on',  to_jsonb(v_rls),
    'grants_revoked_on', to_jsonb(v_revoked),
    'healed_count', cardinality(v_rls) + cardinality(v_revoked),
    'ran_at', now()
  );
END $function$;

REVOKE EXECUTE ON FUNCTION public.selfheal_audit_table_rls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.selfheal_audit_table_rls() TO service_role;
