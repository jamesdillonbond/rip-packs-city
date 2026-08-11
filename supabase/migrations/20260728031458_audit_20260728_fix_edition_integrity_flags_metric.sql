-- The edition_integrity_flags metric in v_rpc_trust_health read count(*) of
-- v_edition_integrity_flags, which is a per-collection GROUP BY (one row per
-- collection => always 5). So the metric was hard-wired to ~5, could never
-- approach breach_at=50, and the real defect columns it computes were never
-- summed => genuine editions drift was UNMONITORED by this metric.
--
-- Fix: sum the real canonical defect columns (bad circulation + missing tier +
-- missing thumbnail) across collections. Excludes the accepted TS UUID-dupe
-- residue (ts_uuid_dupe_editions, ~6.5k legacy noise) and the structurally-null
-- candy/ufc on-chain-id columns. breach_at 250 sits above the continuous
-- thumbnail-hydration baseline so it catches a real deterioration rather than
-- normal churn. Rebuilt from pg_get_viewdef via a guarded regexp_replace so the
-- rest of the (large) sentinel view is byte-identical; security_invoker
-- re-asserted because CREATE OR REPLACE VIEW wipes reloptions.
--
-- REVERT: restore the original arm ->
--   ( SELECT (count(*))::numeric FROM v_edition_integrity_flags) AS count,
--   (50)::numeric, 'bad circulation / tier / keying drift'
-- then ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on).
DO $mig$
DECLARE body text; newbody text;
BEGIN
  body := pg_get_viewdef('public.v_rpc_trust_health'::regclass);
  newbody := regexp_replace(body,
    '\(\s*SELECT\s*\(count\(\*\)\)::numeric AS count\s*FROM v_edition_integrity_flags\) AS count,\s*\(50\)::numeric AS "numeric",\s*''bad circulation / tier / keying drift''::text AS text',
    '( SELECT COALESCE(sum(v.canonical_bad_circulation + v.canonical_missing_tier + v.canonical_missing_thumbnail), 0)::numeric FROM v_edition_integrity_flags v) AS count, (250)::numeric AS "numeric", ''canonical editions defects summed across collections: null/0 circulation + missing tier + missing thumbnail. Excludes accepted TS UUID-dupe residue and the structurally-null candy/ufc on-chain-id columns. FIXED 2026-07-28: previously counted ROWS of the per-collection GROUP BY view (always 5) so it never summed defects and could not breach. breach_at 250 sits above the continuous thumbnail-hydration baseline to catch a real deterioration (dupe-writer leak, hydration-cron death, whole-set tier/circ wipe) not normal churn''::text AS text',
    'g');
  IF newbody = body THEN
    RAISE EXCEPTION 'edition_integrity_flags arm not matched — aborting to avoid a silent no-op replace';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || newbody;
  EXECUTE 'ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)';
END $mig$;