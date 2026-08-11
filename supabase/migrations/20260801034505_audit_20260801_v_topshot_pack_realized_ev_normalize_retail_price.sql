-- Last remaining surface carrying raw UFix64 retail prices: v_topshot_pack_realized_ev
-- had 21 rows >= 1000000 (max 69,900,000,000). Same transform already shipped and
-- verified on v_topshot_pack_lifecycle + pack_distributions_v today; conversion was
-- validated against pack_ev_latest primary prices (exact matches on 699/249/79/69).
-- Guarded replace: RAISEs rather than silently no-op'ing if the expression moved.
-- REVERT: restore `NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric
--         AS retail_price_usd,` in the view body.
DO $mig$
DECLARE
  v_def text;
  v_old text := 'NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text)::numeric AS retail_price_usd,';
  v_new text := 'CASE WHEN (NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text))::numeric >= 1000000::numeric THEN round((NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text))::numeric * 0.00000001, 2) ELSE (NULLIF(d.metadata ->> ''retail_price_usd''::text, ''''::text))::numeric END AS retail_price_usd,';
BEGIN
  v_def := pg_get_viewdef('public.v_topshot_pack_realized_ev'::regclass, true);
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'retail_price_usd expression not found verbatim in v_topshot_pack_realized_ev - aborting rather than silently no-op';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_topshot_pack_realized_ev AS ' || replace(v_def, v_old, v_new);
END
$mig$;

ALTER VIEW public.v_topshot_pack_realized_ev SET (security_invoker = on);