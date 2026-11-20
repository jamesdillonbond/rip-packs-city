-- audit_20261119_failure_rate_cap_holds_when_most_failures_are_upstream
--
-- 2026-11-19 ~9:30 PM PT (Claude Code cloud; Trevor: "Keep going … leaving nothing unresolved").
--
-- FINDING (live 9:14 PM PT). pinnacle-wmc-render-id went `high`: "29/48 runs failed (60.4 %) … Last
-- error: derive: canceling statement due to statement timeout". Its 30 failures in 3 days: 3 named
-- "(first: GQL 530)", 26 BARE "N gql chunk errors" (11-17 4:37 PM → 11-18 5:37 PM PT — the #218 Studio
-- outage window; the lane only started naming the 530 in its error text on 11-18, so the text cannot
-- prove it), and ONE derive statement timeout (11-19 6:37 PM PT; two clean runs since; the only one in
-- 7 days). The upstream caps (20261119014903 for 530, 20261119171500 for an Atlas challenge) key on the
-- NEWEST error only, so one unrelated failure re-exposed the outage pool — and the arm would page
-- `high` (email + Telegram via /api/check-alerts) until the streak split clears it ~20 h later.
--
-- FIX. The cap now ALSO holds when the lane's failures WITHOUT A NAMED UPSTREAM CAUSE (530 / 1033 /
-- Cloudflare challenge), over the same ~3-day window read from pipeline_runs (index
-- pipeline_runs_pipeline_started_idx; retention ~73 h covers it), are under HALF its runs — i.e. its
-- own failure rate alone is below the arm's 50 % `high` line. Evaluated only for a row that would
-- otherwise be `high`. The detail states the split, and calls those failures UNATTRIBUTED, not "ours":
-- here 27 of 72, 26 of which are the unlabelled outage. Measured (dry run, rolled back):
-- pinnacle-wmc-render-id high → medium; no other row changed.
-- ⚠ TRADE, stated: a lane whose own failures sit below half its runs while an outage pushes the pooled
-- rate over 50 % reads `medium` — the same as it would with no outage. A lane whose unattributed
-- failures reach half its runs still pages `high`, outage history or not.
--
-- Base: live prosrc md5 a4d95fc3c62f8cd5cbffc835a8957134 (the 20261119171500 output), asserted.
-- REVERT: swap each ($new$, $old$) pair and re-run with the md5 guard set to this migration's output.

DO $mig$
DECLARE
  def text;
  src text;
  o1 text := $old$(SELECT CASE WHEN sv.v = 'high'
                      AND COALESCE(f.latest_error, f.last_error) ~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)|cloudflare challenge'
                     THEN 'medium' ELSE sv.v END$old$;
  n1 text := $new$(SELECT CASE WHEN sv.v = 'high'
                      AND (COALESCE(f.latest_error, f.last_error) ~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)|cloudflare challenge'
                           -- 2026-11-19: or MOST of the window's failures were upstream (one unrelated
                           -- failure must not re-expose a pool that is almost all outage).
                           OR (SELECT 2 * count(*) FILTER (WHERE NOT pr.ok
                                        AND COALESCE(pr.error, '') !~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)|cloudflare challenge')
                                      < count(*)
                                 FROM public.pipeline_runs pr
                                WHERE pr.pipeline = f.pipeline
                                  AND pr.started_at > now() - interval '3 days'))
                     THEN 'medium' ELSE sv.v END$new$;
  o2 text := $old$THEN ' — UPSTREAM CLOUDFLARE CHALLENGE on Atlas (a ~5-15 % base rate; every retry was exhausted, so this run wrote nothing and is honestly ok=false): capped at medium so it does not page; it re-pages at high once the newest error is anything else.'
             ELSE '' END$old$;
  n2 text := $new$THEN ' — UPSTREAM CLOUDFLARE CHALLENGE on Atlas (a ~5-15 % base rate; every retry was exhausted, so this run wrote nothing and is honestly ok=false): capped at medium so it does not page; it re-pages at high once the newest error is anything else.'
             WHEN f.fail_pct >= 50 THEN
               COALESCE((SELECT ' — ONLY ' ||
                                count(*) FILTER (WHERE NOT pr.ok AND COALESCE(pr.error, '') !~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)|cloudflare challenge') ||
                                ' of ' || count(*) || ' runs in ~3 days failed WITHOUT a named upstream cause (530 / 1033 / Cloudflare challenge): below the 50 % high line on their own, so capped at medium; it pages high once those pass half its runs.'
                           FROM public.pipeline_runs pr
                          WHERE pr.pipeline = f.pipeline AND pr.started_at > now() - interval '3 days'
                         HAVING 2 * count(*) FILTER (WHERE NOT pr.ok AND COALESCE(pr.error, '') !~* '(http|gql|status)\s*:?\s*530([^0-9]|$)|error code:\s*1033([^0-9]|$)|cloudflare challenge') < count(*)), '')
             ELSE '' END$new$;
  frag text; nf text; n int; i int;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.get_pipeline_alerts_core()'::regprocedure;
  IF md5(src) <> 'a4d95fc3c62f8cd5cbffc835a8957134' THEN
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
