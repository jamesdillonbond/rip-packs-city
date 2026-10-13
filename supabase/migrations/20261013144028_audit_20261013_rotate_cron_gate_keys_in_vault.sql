-- audit_20261013_rotate_cron_gate_keys_in_vault
--
-- 2026-10-13 ~7:50 AM PT (Claude Code cloud; register D2b, Trevor approved the
-- rotation pass in chat). STEP 4 — the rotation itself.
--
-- WHY. The previous gate-key values for these lanes were burned: several are in
-- public git history (#22), and until 20261013143723 every tick also wrote them
-- into the edge-function request logs as `?key=`.
--
-- WHY THIS IS SAFE IN ONE STEP. Since this morning both sides read the SAME Vault
-- secret `cron_gate_key__<fn>`: pg_cron through public.cron_gate_key('<fn>') at
-- dispatch time, and each edge function through supabase/functions/_shared/
-- cron-gate.ts at request time. Updating the secret therefore moves cron and
-- function together — there is no window in which they disagree, and no env
-- secret, dashboard step or human copy is involved.
--
-- NO VALUE IS EVER READ OUT. Each new key is generated here
-- ('rpc_pls_' || 32 hex chars from 128 random bits) and written straight into
-- Vault. The assertions compare digests and shape only.
--
-- SCOPE: the 13 Vault-gated functions. NOT rotated, deliberately:
-- `resolve-allday-pull-editions` and `backfill-allday-dist-opened` — their
-- deployed builds have no committed source and check a different value (R21);
-- rotating their Vault secret would 403 their cron.
--
-- NEGATIVE CONTROL. After rotating, the OLD key of `ingest-golazos-pack-opens` is
-- replayed against that function via pg_net (header only). The function now
-- compares against the NEW value, so the response must be 403. Only the pg_net
-- request id is stored (audit_20261013_rotation_control) — never the key.
--
-- REVERT: there is nothing to revert TO — the old values are burned by design.
-- If a lane misbehaves, rotate that one secret again the same way:
--   SELECT vault.update_secret(id, 'rpc_pls_' || encode(extensions.gen_random_bytes(16), 'hex'))
--   FROM vault.secrets WHERE name = 'cron_gate_key__<fn>';

CREATE TABLE IF NOT EXISTS public.audit_20261013_rotation_control (
  fn         text        NOT NULL,
  request_id bigint      NOT NULL,
  note       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.audit_20261013_rotation_control FROM PUBLIC, anon, authenticated;
ALTER TABLE public.audit_20261013_rotation_control ENABLE ROW LEVEL SECURITY;

DO $rot$
DECLARE
  v_fns text[] := ARRAY[
    'backfill-allday-pack-sales', 'backfill-golazos-pack-sales', 'backfill-topshot-pack-sales',
    'backfill-topshot-pack-supply', 'compute-golazos-pack-ev', 'compute-pinnacle-pack-ev',
    'hybrid-custody-backfill', 'ingest-allday-pack-opens', 'ingest-golazos-pack-opens',
    'ingest-pinnacle-mints', 'ingest-pinnacle-pack-opens', 'ingest-topshot-pack-opens-history',
    'resolve-allday-rip-dist-api'
  ];
  v_fn       text;
  v_id       uuid;
  v_old_md5  text;
  v_new      text;
  v_old_ctrl text;
  v_req      bigint;
  v_done     int := 0;
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    SELECT s.id, md5(d.decrypted_secret) INTO v_id, v_old_md5
    FROM vault.secrets s JOIN vault.decrypted_secrets d ON d.id = s.id
    WHERE s.name = 'cron_gate_key__' || v_fn;
    IF v_id IS NULL THEN RAISE EXCEPTION 'no Vault secret for %', v_fn; END IF;

    IF v_fn = 'ingest-golazos-pack-opens' THEN
      SELECT d.decrypted_secret INTO v_old_ctrl FROM vault.decrypted_secrets d WHERE d.id = v_id;
    END IF;

    v_new := 'rpc_pls_' || encode(extensions.gen_random_bytes(16), 'hex');
    PERFORM vault.update_secret(v_id, v_new);

    IF (SELECT md5(decrypted_secret) FROM vault.decrypted_secrets WHERE id = v_id) = v_old_md5 THEN
      RAISE EXCEPTION '%: secret did not change', v_fn;
    END IF;
    IF public.cron_gate_key(v_fn) !~ '^rpc_pls_[0-9a-f]{32}$' THEN
      RAISE EXCEPTION '%: new secret has the wrong shape', v_fn;
    END IF;
    v_done := v_done + 1;
  END LOOP;
  IF v_done <> 13 THEN RAISE EXCEPTION 'expected 13 rotations, did %', v_done; END IF;

  -- distinct keys per lane (the five pack lanes used to share one value)
  IF (SELECT count(DISTINCT md5(public.cron_gate_key(f))) FROM unnest(v_fns) f) <> 13 THEN
    RAISE EXCEPTION 'rotated keys are not all distinct';
  END IF;

  -- negative control: replay the OLD golazos key; it must now be refused (403)
  SELECT net.http_get(
    url := 'https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/ingest-golazos-pack-opens?pages=1',
    headers := jsonb_build_object('x-rpc-gate-key', v_old_ctrl),
    timeout_milliseconds := 30000) INTO v_req;
  INSERT INTO public.audit_20261013_rotation_control (fn, request_id, note)
  VALUES ('ingest-golazos-pack-opens', v_req, 'OLD key replayed after rotation; expect 403');
  v_old_ctrl := NULL;
END
$rot$;
