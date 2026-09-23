-- audit_20260922_cron_commands_drop_their_literal_gate_keys
--
-- STEP 2 OF THE DE-LITERALISE PATH (see 20260923005906). Rewrites every pg_cron
-- command that carries a literal `?key=rpc_pls_…` so it calls
-- `public.cron_gate_key('<edge-fn>')` instead. After this, no gate key exists in
-- `cron.job.command` and the transcript-leak surface is gone.
--
-- ⚠ THE REWRITE IS A TREE WALK, NOT A JOB LIST. It selects on `command ~
-- 'rpc_pls_'` rather than naming jobids, so a job added between the measurement
-- and this migration is still caught, and re-running it is a no-op. The 13 jobs
-- present at authoring time were 15, 16, 20, 22, 25, 26, 27, 29, 42, 44, 56, 83,
-- 84 — but that list is a DATED SAMPLE and is deliberately not encoded.
--
-- ⭐ JOB 84 WAS MIGRATED FIRST, BY HAND, AND VERIFIED BEFORE THE REST. It runs
-- `*/2`, so it gives the fastest falsifier. This migration is therefore a no-op
-- for 84 (its command no longer matches `rpc_pls_`).
--
-- ⛔ THE EQUIVALENCE GUARD IS EXACT AND IT IS LOAD-BEARING. The obvious check —
-- collapse `key=[^&']+` on both sides and compare — is WRONG once the rewrite has
-- run, because the injected text contains a single quote, so the character class
-- stops early and every rewrite reads as "altered more than the key". (That guard
-- is what `rotate_cron_gate_key` uses, and it is correct THERE because that
-- function replaces one literal with another.) Here the new key span is known
-- text, so the check replaces exactly that span back to the same token and
-- compares skeletons. A mismatch aborts the whole migration.
--
-- ⚠ A FAILURE IS LOUD BY CONSTRUCTION. `cron_gate_key` RAISES when a secret is
-- missing, so a mis-keyed job fails its run with a clear message rather than
-- issuing an unauthenticated call that the edge function answers 401 — the
-- latter would look like a lane outage.
--
-- REVERT: there is no way back from this file alone — the literals are gone from
-- the database by design. To restore a literal for one job, read the value from
-- `vault.decrypted_secrets` (name `cron_gate_key__<fn>`) and
-- `SELECT cron.alter_job(<id>, command := <command with the literal>)`. Reverting
-- 20260923005906 (dropping the accessor) WITHOUT reverting this file first would
-- break all 13 lanes.

DO $mig$
DECLARE
  r          record;
  v_fn       text;
  v_expr     text;
  v_new      text;
  v_skel_old text;
  v_skel_new text;
  v_done     int := 0;
BEGIN
  FOR r IN SELECT jobid, command FROM cron.job WHERE command ~ 'rpc_pls_' ORDER BY jobid LOOP
    v_fn := (regexp_match(r.command, '/functions/v1/([a-zA-Z0-9_-]+)'))[1];

    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'job %: carries a gate key but no /functions/v1/<fn> path', r.jobid;
    END IF;

    -- Fail before writing if the secret is not in place for this function.
    PERFORM public.cron_gate_key(v_fn);

    v_expr := '''' || ' || public.cron_gate_key(' || quote_literal(v_fn) || ') || ' || '''';
    v_new  := regexp_replace(r.command, 'key=[^&'']+', 'key=' || v_expr);

    v_skel_old := regexp_replace(r.command, 'key=[^&'']+', 'key=<K>');
    v_skel_new := replace(v_new, 'key=' || v_expr, 'key=<K>');

    IF v_skel_new IS DISTINCT FROM v_skel_old THEN
      RAISE EXCEPTION 'job %: rewrite altered more than the key span', r.jobid;
    END IF;
    IF v_new ~ 'rpc_pls_' THEN
      RAISE EXCEPTION 'job %: still carries a literal key after rewrite', r.jobid;
    END IF;

    PERFORM cron.alter_job(r.jobid, command := v_new);
    v_done := v_done + 1;
  END LOOP;

  RAISE NOTICE 'de-literalised % cron commands', v_done;
END
$mig$;

-- The property, asserted at zero population: no cron command may carry a literal
-- gate key. Satisfiable when there are no such jobs at all, so it does not
-- punish its own success.
DO $assert$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left FROM cron.job WHERE command ~ 'rpc_pls_';
  IF v_left > 0 THEN
    RAISE EXCEPTION '% cron command(s) still carry a literal gate key', v_left;
  END IF;
END
$assert$;
