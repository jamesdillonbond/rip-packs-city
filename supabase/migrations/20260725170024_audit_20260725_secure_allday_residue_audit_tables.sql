-- Applied live 2026-07-25 via MCP; committed for parity.
-- Closes 2 hard smoke-test violations (sentinel): check_public_security_invariants()
-- reported rls_off_base_table on two AllDay residue audit tables, BOTH of which were
-- also anon-readable (queryable at /rest/v1/<table> with the public anon key).
-- Mirrors the measured house pattern: of 64 audit_* tables, 62 already had RLS on
-- with ZERO policies (deny-all to non-bypassrls roles); service_role/postgres retain
-- access. RLS + per-role REVOKE live in the SAME migration on purpose -- a
-- create-then-normalize-later gap is what caused this failure in the first place.
ALTER TABLE public.audit_20260725_allday_v1_unsplittable_retag  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260725_allday_unmapped_dedupe_tx_nft ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.audit_20260725_allday_v1_unsplittable_retag  FROM anon, authenticated;
REVOKE ALL ON public.audit_20260725_allday_unmapped_dedupe_tx_nft FROM anon, authenticated;

COMMENT ON TABLE public.audit_20260725_allday_v1_unsplittable_retag IS
  'Internal audit trail (AllDay V1 unsplittable retag, 2026-07-25). RLS on, no policies: service_role only.';
COMMENT ON TABLE public.audit_20260725_allday_unmapped_dedupe_tx_nft IS
  'Internal audit trail (AllDay unmapped (tx,nft) dedupe, 2026-07-25). RLS on, no policies: service_role only.';
