-- audit_20261014_r21_last_two_lanes_header_and_rotate
--
-- 2026-10-14 ~6:55 AM PT (Claude Code cloud; register R21 residual, continuing the
-- 10-13 D2b pass Trevor approved in chat). The last two pg_cron lanes on `?key=`:
--   jobid 22  rpc-allday-resolve-pull-editions -> resolve-allday-pull-editions
--   jobid 27  rpc-allday-dist-opened-backfill  -> backfill-allday-dist-opened
--
-- PRECONDITION (met this morning): both functions are now committed and deployed on
-- supabase/functions/_shared/cron-gate.ts (v35 / v33 via edge-fn-deploy.yml, read-back
-- clean), so each reads the SAME Vault secret cron sends. Verified as the real caller
-- before this migration: both answered 200 past the gate.
--
-- STEP A — move the key out of the URL into the x-rpc-gate-key header, exactly as
-- 20261013143723 did for the other 18 (Supabase edge logs record full request URLs).
-- STEP B — rotate both Vault secrets. Their current values equal the old hardcoded
-- literals, which never had a guard and are burned. New values are generated here and
-- never read out; assertions compare digests and shape only. One step is enough
-- because cron and function read the same secret.
--
-- NEGATIVE CONTROL: the OLD backfill-allday-dist-opened key is replayed (header only)
-- after rotation; it must be refused 403. Only the pg_net request id is stored, in
-- audit_20261013_rotation_control (created by 20261013144028) — never the key.
--
-- REVERT: step A only — for each job, cron.alter_job back to
--   SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/<fn>?key=' || public.cron_gate_key('<fn>') || '&<params>', timeout_milliseconds:=55000);
-- with <params> `mode=resolve&limit=300` (22) and `n=100` (27). Step B has nothing to
-- revert TO (burned by design); re-roll one lane with
--   SELECT vault.update_secret(id, 'rpc_pls_' || encode(extensions.gen_random_bytes(16), 'hex'))
--   FROM vault.secrets WHERE name = 'cron_gate_key__<fn>';

DO $mig$
DECLARE
  r      record;
  v_fn   text;
  v_new  text;
  v_done int := 0;
BEGIN
  FOR r IN SELECT jobid, command FROM cron.job WHERE jobid IN (22, 27) ORDER BY jobid LOOP
    v_fn := (regexp_match(r.command, '/functions/v1/([a-z0-9-]+)'))[1];
    IF v_fn IS NULL THEN RAISE EXCEPTION 'job %: no /functions/v1/<fn> path', r.jobid; END IF;
    IF (r.jobid = 22 AND v_fn <> 'resolve-allday-pull-editions')
       OR (r.jobid = 27 AND v_fn <> 'backfill-allday-dist-opened') THEN
      RAISE EXCEPTION 'job % calls an unexpected function %', r.jobid, v_fn;
    END IF;
    IF r.command !~ ('\?key='' \|\| public\.cron_gate_key\(''' || v_fn || '''\) \|\| ''') THEN
      RAISE EXCEPTION 'job %: key expression is not the expected own-slug form', r.jobid;
    END IF;
    PERFORM public.cron_gate_key(v_fn);

    v_new := regexp_replace(r.command, '\?key='' \|\| public\.cron_gate_key\(''([a-z0-9-]+)''\) \|\| ''&?', '?');
    v_new := replace(v_new, '?''', '''');
    v_new := regexp_replace(v_new, ',(\s*)timeout_milliseconds(\s*):=',
               ', headers := jsonb_build_object(''x-rpc-gate-key'', public.cron_gate_key(' || quote_literal(v_fn) || ')),\1timeout_milliseconds\2:=');

    IF v_new ~ 'key=' THEN RAISE EXCEPTION 'job %: URL still carries key=', r.jobid; END IF;
    IF v_new !~ 'x-rpc-gate-key' THEN RAISE EXCEPTION 'job %: header not added', r.jobid; END IF;
    IF (length(v_new) - length(replace(v_new, 'cron_gate_key(', ''))) / length('cron_gate_key(') <> 1 THEN
      RAISE EXCEPTION 'job %: expected exactly one cron_gate_key call', r.jobid;
    END IF;

    PERFORM cron.alter_job(r.jobid, command := v_new);
    v_done := v_done + 1;
  END LOOP;
  IF v_done <> 2 THEN RAISE EXCEPTION 'expected to move 2 jobs, moved %', v_done; END IF;
END
$mig$;

DO $rot$
DECLARE
  v_fns text[] := ARRAY['resolve-allday-pull-editions', 'backfill-allday-dist-opened'];
  v_fn       text;
  v_id       uuid;
  v_old_md5  text;
  v_old_ctrl text;
  v_req      bigint;
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    SELECT s.id, md5(d.decrypted_secret) INTO v_id, v_old_md5
    FROM vault.secrets s JOIN vault.decrypted_secrets d ON d.id = s.id
    WHERE s.name = 'cron_gate_key__' || v_fn;
    IF v_id IS NULL THEN RAISE EXCEPTION 'no Vault secret for %', v_fn; END IF;
    IF v_fn = 'backfill-allday-dist-opened' THEN
      SELECT d.decrypted_secret INTO v_old_ctrl FROM vault.decrypted_secrets d WHERE d.id = v_id;
    END IF;

    PERFORM vault.update_secret(v_id, 'rpc_pls_' || encode(extensions.gen_random_bytes(16), 'hex'));

    IF (SELECT md5(decrypted_secret) FROM vault.decrypted_secrets WHERE id = v_id) = v_old_md5 THEN
      RAISE EXCEPTION '%: secret did not change', v_fn;
    END IF;
    IF public.cron_gate_key(v_fn) !~ '^rpc_pls_[0-9a-f]{32}$' THEN
      RAISE EXCEPTION '%: new secret has the wrong shape', v_fn;
    END IF;
  END LOOP;

  SELECT net.http_get(
    url := 'https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-allday-dist-opened?mode=probe',
    headers := jsonb_build_object('x-rpc-gate-key', v_old_ctrl),
    timeout_milliseconds := 30000) INTO v_req;
  INSERT INTO public.audit_20261013_rotation_control (fn, request_id, note)
  VALUES ('backfill-allday-dist-opened', v_req, 'OLD key replayed after rotation (10-14); expect 403');
  v_old_ctrl := NULL;
END
$rot$;

DO $assert$
DECLARE v_left int; v_hdr int; v_distinct int;
BEGIN
  SELECT count(*) INTO v_left FROM cron.job WHERE command ~ '\?key=';
  IF v_left > 0 THEN RAISE EXCEPTION '% job(s) still send ?key=', v_left; END IF;
  SELECT count(*) INTO v_hdr FROM cron.job WHERE command ~ 'x-rpc-gate-key';
  IF v_hdr <> 20 THEN RAISE EXCEPTION 'expected 20 header dispatchers, found %', v_hdr; END IF;
  -- every Vault gate key distinct
  SELECT count(DISTINCT md5(d.decrypted_secret)) INTO v_distinct
  FROM vault.secrets s JOIN vault.decrypted_secrets d ON d.id = s.id
  WHERE s.name LIKE 'cron\_gate\_key\_\_%';
  IF v_distinct <> (SELECT count(*) FROM vault.secrets WHERE name LIKE 'cron\_gate\_key\_\_%') THEN
    RAISE EXCEPTION 'Vault gate keys are not all distinct';
  END IF;
END
$assert$;
