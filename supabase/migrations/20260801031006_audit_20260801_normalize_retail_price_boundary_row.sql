-- Move both retail-price normalizers from '> 1000000' to '>= 1000000'.
-- The threshold boundary was arbitrary and excluded exactly one row: dist 8227
-- "NBA Top Shot x NBA ID", raw 1000000. Every satoshi-encoded value in this set is
-- of the form price * 1e8, so 1000000 = $0.01 -- a plausible promo price, and the
-- CONSISTENT reading of its 107 siblings. The excluded reading ($1,000,000 retail
-- for a 20,000-mint pack trading at $29 secondary) is certainly wrong, and it was
-- rendering on the public pack lifecycle page.
-- REVERT: change '>= 1000000' back to '> 1000000' in both view definitions.
DO $mig$
DECLARE
  v_def text;
BEGIN
  -- 1. v_topshot_pack_lifecycle (public display surface)
  v_def := pg_get_viewdef('public.v_topshot_pack_lifecycle'::regclass, true);
  IF position('::numeric > 1000000::numeric' in v_def) = 0 THEN
    RAISE EXCEPTION 'threshold not found in v_topshot_pack_lifecycle - aborting';
  END IF;
  v_def := replace(v_def, '::numeric > 1000000::numeric', '::numeric >= 1000000::numeric');
  EXECUTE 'CREATE OR REPLACE VIEW public.v_topshot_pack_lifecycle AS ' || v_def;

  -- 2. pack_distributions_v (the original normalizer, so the two agree)
  v_def := pg_get_viewdef('public.pack_distributions_v'::regclass, true);
  IF position('::numeric) > 1000000::numeric' in v_def) = 0 THEN
    RAISE EXCEPTION 'threshold not found in pack_distributions_v - aborting';
  END IF;
  v_def := replace(v_def, '::numeric) > 1000000::numeric', '::numeric) >= 1000000::numeric');
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_distributions_v AS ' || v_def;
END
$mig$;

ALTER VIEW public.v_topshot_pack_lifecycle SET (security_invoker = on);
ALTER VIEW public.pack_distributions_v      SET (security_invoker = on);
GRANT SELECT ON public.v_topshot_pack_lifecycle TO anon, authenticated, service_role;