-- v_topshot_pack_lifecycle.retail_price_usd read pack_distributions.metadata RAW,
-- so 108 Top Shot dists whose retail price is stored in UFix64 (x1e8) units rendered
-- as up to $69,900,000,000 on the pack lifecycle page + its OG card. The view is
-- anon-SELECTable, so this was live user-facing. pack_table_rows and
-- topshot_pack_ev_targets were already clean (0 satoshi rows), so the EV pipeline
-- is unaffected -- this is a display fix only.
-- Conversion verified against the independent primary price in pack_ev_latest:
-- 699/249/79/69 matched exactly on every dist with price_source IS NULL.
-- Uses the SAME '> 1000000' threshold as the existing pack_distributions_v
-- normalizer for consistency; the single boundary row (dist 8227, raw exactly
-- 1000000) is deliberately left alone as ambiguous.
-- Rebuild via guarded string replace so the rest of the 4.4k-char body is byte-identical.
-- REVERT: re-apply the prior definition (git history) or replace the CASE with
--   NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric AS retail_price_usd,
DO $mig$
DECLARE
  v_def   text;
  v_old   text := 'NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text)::numeric AS retail_price_usd,';
  v_new   text := 'CASE WHEN (NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text))::numeric > 1000000::numeric THEN round((NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text))::numeric * 0.00000001, 2) ELSE (NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text))::numeric END AS retail_price_usd,';
BEGIN
  v_def := pg_get_viewdef('public.v_topshot_pack_lifecycle'::regclass, true);

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'retail_price_usd expression not found verbatim in v_topshot_pack_lifecycle - aborting rather than silently no-op';
  END IF;

  v_def := replace(v_def, v_old, v_new);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_topshot_pack_lifecycle AS ' || v_def;
END
$mig$;

-- CREATE OR REPLACE VIEW wipes reloptions; re-assert.
ALTER VIEW public.v_topshot_pack_lifecycle SET (security_invoker = on);
GRANT SELECT ON public.v_topshot_pack_lifecycle TO anon, authenticated, service_role;