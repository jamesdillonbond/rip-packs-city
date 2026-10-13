-- audit_20261013_cron_gate_key_moves_from_url_to_header
--
-- 2026-10-13 ~7:40 AM PT (Claude Code cloud; register D2b, Trevor approved the
-- rotation pass in chat). STEP 3 of the gate-key rotation.
--
-- WHY. Every pg_cron dispatcher sent its edge function's gate key in the URL
-- (`?key=' || public.cron_gate_key('<fn>') || '…`). Supabase edge-function logs
-- record full request URLs, so every tick re-published the key into the log store.
-- Rotating while the key still travelled in the URL would just re-log the new value
-- — hence this step lands BEFORE the rotation.
--
-- PRECONDITION, verified the same morning: each of the functions below now reads
-- the key from the `x-rpc-gate-key` header first (supabase/functions/_shared/
-- cron-gate.ts, deployed from committed source via edge-fn-deploy.yml) and every
-- one answered its real cron caller with a pipeline_runs ok row after its deploy.
--
-- SCOPE: all cron_gate_key dispatchers EXCEPT jobs 22 and 27 —
-- `resolve-allday-pull-editions` and `backfill-allday-dist-opened` have NO
-- committed source; their deployed builds read only `?key=`, so they keep it until
-- their source is recovered (register R21).
--
-- WHAT IT CHANGES, per job, and nothing else (asserted below):
--   url  …/<fn>?key=' || public.cron_gate_key('<fn>') || '&rest'  →  …/<fn>?rest'
--   +    headers := jsonb_build_object('x-rpc-gate-key', public.cron_gate_key('<fn>'))
-- The key is still read from Vault at dispatch time; no value appears anywhere.
--
-- REVERT — exact inverse, safe because every function still accepts ?key= too:
--   DO $r$ DECLARE r record; v_fn text; v_new text; BEGIN
--     FOR r IN SELECT jobid, command FROM cron.job WHERE command ~ 'x-rpc-gate-key' LOOP
--       v_fn  := (regexp_match(r.command, '/functions/v1/([a-z0-9-]+)'))[1];
--       v_new := regexp_replace(r.command,
--                  ', headers := jsonb_build_object\(''x-rpc-gate-key'', public\.cron_gate_key\(''[a-z0-9-]+''\)\),', ',');
--       IF v_new ~ ('/functions/v1/' || v_fn || '\?') THEN
--         v_new := regexp_replace(v_new, '(/functions/v1/' || v_fn || ')\?',
--                    '\1?key='' || public.cron_gate_key(''' || v_fn || ''') || ''&');
--       ELSE
--         v_new := regexp_replace(v_new, '(/functions/v1/' || v_fn || ')''',
--                    '\1?key='' || public.cron_gate_key(''' || v_fn || ''') || ''''');
--       END IF;
--       PERFORM cron.alter_job(r.jobid, command := v_new);
--     END LOOP; END $r$;

DO $mig$
DECLARE
  r      record;
  v_fn   text;
  v_new  text;
  v_done int := 0;
BEGIN
  FOR r IN
    SELECT jobid, command FROM cron.job
    WHERE command ~ 'cron_gate_key' AND command ~ '\?key=' AND jobid NOT IN (22, 27)
    ORDER BY jobid
  LOOP
    v_fn := (regexp_match(r.command, '/functions/v1/([a-z0-9-]+)'))[1];
    IF v_fn IS NULL THEN RAISE EXCEPTION 'job %: no /functions/v1/<fn> path', r.jobid; END IF;
    -- the key accessor must name the SAME function the URL calls
    IF r.command !~ ('\?key='' \|\| public\.cron_gate_key\(''' || v_fn || '''\) \|\| ''') THEN
      RAISE EXCEPTION 'job %: key expression is not the expected own-slug form', r.jobid;
    END IF;
    PERFORM public.cron_gate_key(v_fn);  -- fail before writing if Vault lacks it

    v_new := regexp_replace(r.command, '\?key='' \|\| public\.cron_gate_key\(''([a-z0-9-]+)''\) \|\| ''&?', '?');
    v_new := replace(v_new, '?''', '''');
    v_new := regexp_replace(v_new, ',(\s*)timeout_milliseconds(\s*):=',
               ', headers := jsonb_build_object(''x-rpc-gate-key'', public.cron_gate_key(' || quote_literal(v_fn) || ')),\1timeout_milliseconds\2:=');

    IF v_new ~ 'key=' THEN RAISE EXCEPTION 'job %: URL still carries key=', r.jobid; END IF;
    IF v_new !~ 'x-rpc-gate-key' THEN RAISE EXCEPTION 'job %: header not added', r.jobid; END IF;
    IF (length(v_new) - length(replace(v_new, 'cron_gate_key(', ''))) / length('cron_gate_key(') <> 1 THEN
      RAISE EXCEPTION 'job %: expected exactly one cron_gate_key call', r.jobid;
    END IF;
    IF v_new !~ ('cron_gate_key\(''' || v_fn || '''\)') THEN
      RAISE EXCEPTION 'job %: header reads another function''s key', r.jobid;
    END IF;

    PERFORM cron.alter_job(r.jobid, command := v_new);
    v_done := v_done + 1;
  END LOOP;
  IF v_done <> 18 THEN RAISE EXCEPTION 'expected to move 18 jobs, moved %', v_done; END IF;
END
$mig$;

DO $assert$
DECLARE v_left int; v_hdr int;
BEGIN
  SELECT count(*) INTO v_left FROM cron.job WHERE command ~ '\?key=' AND jobid NOT IN (22, 27);
  IF v_left > 0 THEN RAISE EXCEPTION '% job(s) outside 22/27 still send ?key=', v_left; END IF;
  SELECT count(*) INTO v_hdr FROM cron.job WHERE command ~ 'x-rpc-gate-key';
  IF v_hdr <> 18 THEN RAISE EXCEPTION 'expected 18 header dispatchers, found %', v_hdr; END IF;
END
$assert$;
