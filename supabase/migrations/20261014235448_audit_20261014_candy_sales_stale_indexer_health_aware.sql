DO $mig$
DECLARE
  body text;
  n int;
  old_anchor text := $anc$30::numeric AS "numeric",
            'candy-sales-indexer stalled — the ONLY Candy price signal. 7d p95 inter-sale gap 0.91h, avg 0.30h'::text$anc$;
  new_arm text := $new$CASE WHEN COALESCE(EXTRACT(epoch FROM now() - ( SELECT max(pr.started_at) FROM pipeline_runs pr WHERE pr.pipeline = 'candy-sales-indexer'::text AND pr.ok)) / 3600::numeric, 999::numeric) > 7::numeric THEN 0::numeric WHEN ( SELECT count(*) FROM candy_sales_unresolved u WHERE u.resolved_at IS NULL AND u.first_seen_at > (now() - '48:00:00'::interval)) > 50 THEN 0::numeric ELSE 168::numeric END AS "numeric",
            'candy-sales-indexer freshness, indexer-health-aware (retune 2026-10-14). value = hours since last Candy sale. breach_at is 0 (breach now) when the indexer is UNHEALTHY (no ok candy-sales-indexer run in the last 7h, i.e. stalled or erroring; OR more than 50 new unresolved Candy sales parked in 48h), else 168h, a 7-day backstop so a truly indefinite silence still pages but an ordinary frozen thin market with a healthy indexer does NOT. Prior flat breach_at 30 false-alarmed on the 2026-10-13 Candy market freeze (live Magic Eden /activities A/B confirmed no capture bug).'::text$new$;
BEGIN
  body := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);
  n := (length(body) - length(replace(body, old_anchor, ''))) / length(old_anchor);
  IF n <> 1 THEN
    RAISE EXCEPTION 'candy_sales_stale anchor matched % times, expected 1 -- aborting', n;
  END IF;
  body := replace(body, old_anchor, new_arm);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health WITH (security_invoker=on) AS ' || body;
END
$mig$;