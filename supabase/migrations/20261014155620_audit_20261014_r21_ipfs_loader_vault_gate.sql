-- audit_20261014_r21_ipfs_loader_vault_gate
--
-- 2026-10-14 (Claude Code cloud; register R21 (c)). Creates the Vault secret the converted
-- ipfs-catalog-loader (v4, supabase/functions/ipfs-catalog-loader) checks through
-- _shared/cron-gate.ts. Its only caller is scripts/refresh-ipfs-catalog.mjs, which reads the
-- key at run time via public.cron_gate_key('ipfs-catalog-loader') with the service-role key.
--
-- The value is generated here and never selected; assertions read digest and shape only.
-- Idempotent: if the secret already exists it is left alone.
--
-- REVERT: DELETE FROM vault.secrets WHERE name = 'cron_gate_key__ipfs-catalog-loader';
--   (the loader then answers 503 gate_unavailable until it exists again).

DO $mig$
DECLARE v_md5 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_gate_key__ipfs-catalog-loader') THEN
    PERFORM vault.create_secret(
      'rpc_pls_' || encode(extensions.gen_random_bytes(16), 'hex'),
      'cron_gate_key__ipfs-catalog-loader',
      'Gate key for the ipfs-catalog-loader edge function (operator script reads it via cron_gate_key). R21, 2026-10-14.'
    );
  END IF;

  IF public.cron_gate_key('ipfs-catalog-loader') !~ '^rpc_pls_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'ipfs-catalog-loader gate key has the wrong shape';
  END IF;
  -- distinct from every other gate key. The digest is taken ONCE: calling cron_gate_key
  -- inside the subquery raised "no vault secret" on the first apply (rolled back).
  SELECT md5(d.decrypted_secret) INTO v_md5 FROM vault.decrypted_secrets d
  WHERE d.name = 'cron_gate_key__ipfs-catalog-loader';
  IF (SELECT count(*) FROM vault.decrypted_secrets d
      WHERE d.name LIKE 'cron\_gate\_key\_\_%' AND md5(d.decrypted_secret) = v_md5) <> 1 THEN
    RAISE EXCEPTION 'ipfs-catalog-loader gate key collides with another gate key';
  END IF;
END
$mig$;
