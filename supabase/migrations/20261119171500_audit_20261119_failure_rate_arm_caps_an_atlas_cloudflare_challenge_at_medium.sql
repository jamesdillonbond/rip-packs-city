-- audit_20261119_failure_rate_arm_caps_an_atlas_cloudflare_challenge_at_medium
--
-- 2026-11-19 ~5:20 PM PT (Claude Code cloud; Trevor: "work through anything else unresolved from
-- this thread"). Follow-on to 20261119123000 ("a Cloudflare challenge is a retry"), filed by the
-- daytime monitor at 5:05 PM PT (inbox 2026-11-20T0105Z…pinnacle-pack-ev-403-not-reclassified).
--
-- FINDING. compute-pinnacle-pack-ev was the ONLY `high` failure_rate row: 5/9 runs failed in 3 days =
-- four Dapper 530s (#218, already capped at medium by 20261119014903) plus ONE Atlas
-- `SearchDistributions: HTTP 403 (cloudflare challenge) after 4 attempt(s)` (11-19 4:17 AM PT). Because
-- that newest error was a challenge, not a 530, the 530 cap released and the row paged `high`. Newest
-- run (11-19 10:17 AM PT) is ok; Pinnacle freshness arms are green.
--
-- WHY NOT "count the challenge as ok" (the monitor's suggestion, and what 20261119123000 did for pack
-- identity / pulls): those lanes complete their OTHER requests and re-ask a challenged one next tick,
-- so the RUN did its work. A pack-EV walk that exhausts its challenge retries on page 0 writes NO pack
-- EV — `ok=false` is the true record (the write-side honesty rule). The defect is the ALARM's
-- severity, not the run's status.
--
-- FIX. Same shape as the 530 cap: when the arm computes `high` AND the lane's newest error says
-- `cloudflare challenge` (the exact phrase only supabase/functions/_shared/atlas-distributions.ts
-- emits — the All Day / Golazos / Pinnacle pack-EV lanes), the row is emitted at `medium` with a
-- detail suffix saying so. NOT dropped, NOT suppressed; it re-pages at `high` the moment the newest
-- error is anything else. ⚠ TRADE, stated: a lane that Cloudflare blocks on EVERY run would sit at
-- medium; the board still shows it at >= 50 % failed, and the run records keep ok=false.
--
-- Base: live prosrc md5 308c53f6f94762cd203cd5751ed41ca1 (the 20261119014903 output), asserted.
-- Re-created from pg_get_functiondef(), so signature, SECURITY DEFINER, search_path and ACL hold.
--
-- REVERT: swap each ($new$, $old$) pair and re-run with the md5 guard set to this migration's output.

DO $mig$
DECLARE
  def text;
  src text;
  o1 text := $old$AND COALESCE(f.latest_error, f.last_error) ~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)'
                     THEN 'medium'$old$;
  n1 text := $new$AND COALESCE(f.latest_error, f.last_error) ~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)|cloudflare challenge'
                     THEN 'medium'$new$;
  o2 text := $old$THEN ' — UPSTREAM 530 (Dapper Studio down, #218): capped at medium so it does not page; it re-pages at high once the newest error is anything else.'
             ELSE '' END$old$;
  n2 text := $new$THEN ' — UPSTREAM 530 (Dapper Studio down, #218): capped at medium so it does not page; it re-pages at high once the newest error is anything else.'
             WHEN COALESCE(f.latest_error, f.last_error) ~* 'cloudflare challenge'
             THEN ' — UPSTREAM CLOUDFLARE CHALLENGE on Atlas (a ~5-15 % base rate; every retry was exhausted, so this run wrote nothing and is honestly ok=false): capped at medium so it does not page; it re-pages at high once the newest error is anything else.'
             ELSE '' END$new$;
  frag text; nf text; n int; i int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.get_pipeline_alerts_core()'::regprocedure;
  IF md5(src) <> '308c53f6f94762cd203cd5751ed41ca1' THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core drifted (prosrc md5 %); re-derive before splicing', md5(src);
  END IF;
  def := pg_get_functiondef('public.get_pipeline_alerts_core()'::regprocedure);
  FOR i IN 1..2 LOOP
    frag := CASE i WHEN 1 THEN o1 ELSE o2 END;
    nf   := CASE i WHEN 1 THEN n1 ELSE n2 END;
    n := (length(def) - length(replace(def, frag, ''))) / length(frag);
    IF n <> 1 THEN RAISE EXCEPTION 'fragment % found % times, expected 1 — refusing to splice', i, n; END IF;
    def := replace(def, frag, nf);
  END LOOP;
  EXECUTE def;
  IF has_function_privilege('anon', 'public.get_pipeline_alerts_core()', 'execute') THEN
    RAISE EXCEPTION 'anon gained execute on get_pipeline_alerts_core()';
  END IF;
  IF jsonb_typeof(public.get_pipeline_alerts_core()) <> 'array' THEN
    RAISE EXCEPTION 'get_pipeline_alerts_core() no longer returns an array';
  END IF;
END $mig$;
