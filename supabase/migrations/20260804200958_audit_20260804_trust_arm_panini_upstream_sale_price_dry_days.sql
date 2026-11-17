-- 2026-08-04 · Add the panini_upstream_sale_price_dry_days arm to v_rpc_trust_health.
--
-- Pairs with audit_20260804_panini_upstream_sale_price_dry_days_metric, which computes
-- the value in leg 6 of rpc_trust_health_precompute_refresh at zero added cost.
--
-- ⚠ THIS ARM READS 7 AGAINST breach_at 3 AND BREACHES ON ARRIVAL. That is intended and
-- honest: the outage is real, seven days old, and was found by hand rather than by the
-- board. It self-clears the moment upstream resumes. Panini is pre-launch and
-- service_role-only, so this breach is a work item, not a user-facing incident.
--
-- Applied as an anchored string replacement against pg_get_viewdef rather than a retyped
-- 33-arm CREATE OR REPLACE VIEW, so a transcription slip cannot silently alter an
-- unrelated arm. RAISEs if the anchor is absent.
--
-- ⚠ CREATE OR REPLACE VIEW DROPS reloptions -- security_invoker=on is re-set below.

DO $mig$
DECLARE
  v_def text;
  v_new text;
  c_anchor text;
  c_repl   text;
BEGIN
  SELECT pg_get_viewdef('public.v_rpc_trust_health'::regclass, true) INTO v_def;

  c_anchor := 'SELECT ''panini_sale_field_mapping_shortfall''::text AS text,';

  c_repl := 'SELECT ''panini_upstream_sale_price_dry_days''::text AS text,
            COALESCE(( SELECT pre.value
                   FROM pre
                  WHERE pre.metric = ''panini_upstream_sale_price_dry_days''::text), 999::numeric) AS "coalesce",
            3::numeric AS "numeric",
            ''UPSTREAM stopped sending Panini sale prices altogether. Counts the consecutive most-recent CAPTURE DAYS on which v_panini_serial_sale_field_supply saw raw_supplied_sale_price = 0. NOT the same thing as panini_sale_field_mapping_shortfall, which reads 0 and watches whether OUR ingest drops a price upstream DID send: that one is a defect we own and can fix, this one is a supply outage with a different owner entirely, and until 2026-08-04 NOTHING watched it. FOUND BREACHED AT 7 ON 2026-08-04, dry for seven straight days unnoticed: upstream supplied 35-45% of captured serials daily from 07-17 through 07-26, decayed to 13.09% on 07-27 and 1.06% on 07-28, then EXACTLY 0.00% every day from 07-29 to 08-04 -- 44,299 serials captured, 0 sale prices, with mapping_shortfall 0 throughout, so our mapping is faithful and the loss is entirely upstream. WHY IT MATTERS FOR THE LAUNCH GATE: the roadmap tracks share of Panini serials carrying a recorded price as a coverage figure and read its decline (17.3% on 07-28, 8.0% on 07-31, 6.7% on 08-04) as inventory being added faster than prices. It is not. The numerator has been FROZEN since 07-29 while the denominator grew by 44,299, so the decline is arithmetic and no amount of RPC-side work can move it -- a launch gate set on that ratio is currently measuring an upstream outage and cannot be met. COUNTED OVER CAPTURE DAYS, NEVER CALENDAR DAYS: the Panini ingest is a residential Windows box on Task Scheduler that sleeps (worst observed gap 28.30h) and a sleeping box writes no capture rows at all, so it cannot inflate this metric -- that failure mode is already owned by panini_fmv_stale_hours at 36h. breach_at 3 = three consecutive fully-dry capture days. A partial day still counts as supplied (07-28 supplied only 1.06% and correctly breaks the run), and in 19 days of captured history there was no dry day at all before 07-29, so a one- or two-day upstream blip cannot page. SELF-CLEARING: the run resets to 0 the moment upstream resumes. PRECOMPUTED at ZERO added cost, in the same single pass over v_panini_serial_sale_field_supply that panini_sale_field_mapping_shortfall already pays for (a seq scan over ~59k serials plus jsonb, measured 297-605ms); a missing or >24h-old precompute row reports 999 and BREACHES.''::text AS text
        UNION ALL
         SELECT ''panini_sale_field_mapping_shortfall''::text AS text,';

  IF position(c_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'anchor not found: panini_sale_field_mapping_shortfall branch';
  END IF;
  IF position('panini_upstream_sale_price_dry_days' in v_def) > 0 THEN
    RAISE EXCEPTION 'arm already present -- refusing to add it twice';
  END IF;

  v_new := replace(v_def, c_anchor, c_repl);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'no change produced -- refusing to replace the view';
  END IF;

  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || v_new;
  -- MANDATORY: CREATE OR REPLACE VIEW drops reloptions.
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END
$mig$;