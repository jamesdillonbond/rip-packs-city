-- audit_20260905_the_403_arm_can_attribute_the_atlas_walk_because_that_walk_records_its_own_request_ids
--
-- The 2026-08-30 migration (`..._edge_fn_http_arm_stops_asserting_a_cause_it_cannot_observe`)
-- ended with this, verbatim:
--
--   "THE REAL FIX IS STILL OWED and is deliberately not attempted here: persist the
--    dispatch URL (a wrapper that records request_id -> url at dispatch, joined back on
--    net._http_response.id). That needs all 15 call sites changed ... and, measured
--    2026-08-30 05:0xZ, net._http_response currently holds 683 rows over a ~6h retention
--    window with ZERO 4xx in it, so the arm is quiet and the wrapper is not justified by
--    present incidence."
--
-- ⭐ THAT GATING CONDITION HAS FLIPPED, WHICH IS THE ONLY REASON THIS SHIPS NOW.
-- Measured 2026-09-05 11:0xZ: the same ~6h window holds **2,047 responses with 64 4xx in
-- it**, and `atlas_edition_requests` (24h retention) puts the rate at **3-30 per hour, every
-- hour, for the full 24h it can see** — steady, not escalating, and never zero. The arm has
-- therefore been CRITICAL continuously, and the ledger shows the cost: 2026-09-03,
-- 2026-09-04 and 2026-09-05 each opened with a session re-investigating this same alert and
-- writing "benign" (the 09-04 entry says so in those words). Three nights on one row.
--
-- ⛔ AND THE "15 CALL SITES" PREMISE WAS TOO PESSIMISTIC — one dispatcher already does it.
-- `atlas_editions_dispatch()` INSERTs `atlas_edition_requests(request_id, set_id_onchain,
-- offset_at, dispatched_at)` at dispatch time, keyed on the very id `net._http_response`
-- reports back. So the join the 08-30 note asked someone to build ALREADY EXISTS for the
-- estate's highest-volume pg_net caller (8 requests every 2 minutes = 5,760/day, against a
-- daily total that makes every other dispatcher a rounding error). Measured: **6 of 6** 4xx
-- in the live 2h window join to it.
--
-- ── WHY THIS IS NOT THE THING 08-30 REFUSED TO DO ─────────────────────────────
-- That migration wrote: "It would be easy to downgrade a 'GraphQL-shaped body' to low on a
-- HEURISTIC -- and that heuristic would eventually silence a REAL gate-key outage that
-- happened to return JSON."
--
-- ⭐ That warning is about inferring identity from CONTENT. This infers nothing: it reads a
-- request id we recorded ourselves at dispatch. The safety property it was protecting is
-- kept EXACTLY — anything that does not join stays on the original text at the original
-- severity, so an edge function 403ing on a stale `?key=` gate (which is not in
-- `atlas_edition_requests` and never will be) is still CRITICAL, byte-for-byte.
--
-- ── WHY info AND NOT SILENCE ──────────────────────────────────────────────────
-- The Atlas row is not suppressed, it is RE-AIMED at the question that has an answer.
-- A Cloudflare challenge on a third-party API is not a thing we can fix; whether our RETRY
-- keeps up with it is. `atlas_editions_drain()` RAISEs on any non-200 and its handler
-- increments `pages_err` **without advancing `next_offset`** — verified by reading the
-- function, not assumed — so a challenged page is re-walked next cycle and no row is lost.
-- Measured state at ship: 266 sets, **0 never completed**, max staleness 2h04m, p95 1h16m,
-- **0 sets stale beyond 6h**, against a full-cycle time of ~75 min. So the row escalates
-- back to `high` the instant any set crosses 6h without completing a walk — the only
-- reading under which an upstream challenge actually costs catalog freshness.
--
-- ⚠ THE 12-HOUR ATTRIBUTION BOUND IS LOAD-BEARING, NOT A ROUND NUMBER.
-- `atlas_editions_drain()` prunes `atlas_edition_requests` at `drained_at < now() - 24h`.
-- Past that retention, absence from the table means "pruned", NOT "not Atlas" — and
-- attributing on a pruned row would silence a real outage, which is the exact failure the
-- 08-30 migration was written to prevent. So attribution is only claimed for windows
-- <= 12h; a wider window degrades to the ORIGINAL critical text for everything.
--
-- ✅ POSITIVE CONTROLS RUN AFTER APPLYING (both, because a downgrade is only safe if the
--    upgrade path is proven still live):
--      check_edge_fn_http_failures()                  -> atlas-editions-upstream-403, "info",
--                                                        "6 of 480 ... (1.3%)"
--      check_edge_fn_http_failures(interval '30 days') -> pg_net_http_403, "critical"
--    The second is the one that matters: the SAME 62 rows, pushed past the attribution
--    bound, still page as critical. The critical path is not dead, it is gated.
--    get_pipeline_alerts() went from 1 critical + 6 info to **0 critical**, 1 high, 6 info.
--    ACL re-checked after CREATE OR REPLACE: anon=false, authenticated=false,
--    service_role=true, and pg_proc holds exactly ONE overload (the signature is unchanged,
--    so no new default-PUBLIC-EXECUTE overload was created).
--
-- anon-exec: unchanged -- check_edge_fn_http_failures is service_role-only already
-- (anon=false, authenticated=false, re-measured live after this apply); CREATE OR REPLACE
-- on an unchanged signature does not reset a function's ACL, so no revoke is added here.
--
-- REVERT: restore the prior body from this file's git history -- i.e. the body applied by
-- 20260830051052, which is a single flat SELECT with no atlas join and no bounds/atlas/denom
-- CTEs. Nothing else in the estate reads `atlas-editions-upstream-403`; `get_pipeline_alerts`
-- passes rows through untouched, so a revert restores the previous alert text exactly.

CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(p_window interval DEFAULT '02:00:00'::interval)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '10s'
AS $function$
  WITH bounds AS (
    SELECT (p_window <= interval '12 hours') AS can_attribute
  ),
  resp AS (
    SELECT r.status_code,
           r.content,
           (a.request_id IS NOT NULL) AND (SELECT can_attribute FROM bounds) AS is_atlas
      FROM net._http_response r
      LEFT JOIN public.atlas_edition_requests a ON a.request_id = r.id
     WHERE r.created > now() - p_window
       AND r.status_code >= 400
       AND r.status_code <  500
  ),
  atlas AS (
    SELECT count(*)::int AS sets_total,
           count(*) FILTER (WHERE last_completed_at IS NULL
                               OR last_completed_at < now() - interval '6 hours')::int AS sets_stalled,
           COALESCE(round((extract(epoch FROM max(now() - last_completed_at))/3600.0)::numeric, 1), 0) AS max_staleness_h
      FROM public.atlas_set_refresh_state
  ),
  denom AS (
    SELECT count(*)::int AS dispatched
      FROM public.atlas_edition_requests
     WHERE dispatched_at > now() - p_window
  ),
  grp AS (
    SELECT status_code, is_atlas, count(*)::int AS n, left(min(content), 200) AS sample
      FROM resp GROUP BY 1, 2
  )
  SELECT COALESCE(jsonb_agg(s.j ORDER BY s.ord, s.code), '[]'::jsonb)
  FROM (
    SELECT
      CASE WHEN g.is_atlas THEN 1 ELSE 0 END AS ord,
      g.status_code AS code,
      CASE WHEN g.is_atlas THEN
        jsonb_build_object(
          'severity', CASE WHEN a.sets_stalled > 0 THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-editions-upstream-' || g.status_code::text,
          'detail',   g.n || ' of ' || d.dispatched || ' Atlas edition dispatch(es) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || ' (' || CASE WHEN d.dispatched > 0
                                      THEN round(100.0 * g.n / d.dispatched, 1)::text ELSE '?' END
                      || '%). ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'atlas_edition_requests.request_id, which atlas_editions_dispatch() records at '
                      || 'dispatch time. This is NOT the body-shape heuristic the 2026-08-30 arm deliberately '
                      || 'refused; that migration named persisting the dispatch identity as the real fix, and '
                      || 'the Atlas walk is the one dispatcher that already persists it. '
                      || 'NO ROWS ARE LOST: atlas_editions_drain() RAISEs on any non-200, and its handler '
                      || 'increments pages_err WITHOUT advancing next_offset, so the same page is re-walked '
                      || 'on the next cycle. The thing actually worth watching is whether that retry keeps up: '
                      || a.sets_stalled || ' of ' || a.sets_total || ' set(s) have not completed a walk in 6h '
                      || '(oldest ' || a.max_staleness_h || 'h; a full cycle is ~75 min). '
                      || 'THIS ROW ESCALATES TO high the moment that count goes non-zero, which is the only '
                      || 'reading under which an upstream challenge costs catalog freshness. '
                      || 'Body: ' || COALESCE(g.sample, '(empty)')
        )
      ELSE
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (401, 403) THEN 'critical' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'pg_net_http_' || g.status_code::text,
          'detail',   g.n || ' pg_net-dispatched call(s) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || ', NOT attributable to the Atlas editions walk (that walk IS attributable, by a '
                      || 'request_id join, and any of its failures are reported as a separate row). '
                      || 'WHICH ENDPOINT IS UNKNOWN: net._http_response has no url column (the URL lives in '
                      || 'net.http_request_queue, drained on completion), so this arm cannot tell an EDGE FUNCTION '
                      || 'from one of our own DB-dispatched probes. Two readings, and the body below usually settles it: '
                      || '(a) an edge-function MISCONFIGURATION (stale ?key= gate, rotated secret, bad route) -- pg_cron '
                      || 'still logs "succeeded" because DISPATCH worked and the function writes NO pipeline_runs row, '
                      || 'so silence-based checks misread it as a completed no-op walk; '
                      || '(b) SELF-INFLICTED -- a strict upstream rejecting one of our schema probes (a GraphQL-shaped '
                      || 'body, e.g. GRAPHQL_VALIDATION_FAILED, is this case and is not an outage). '
                      || 'Body: ' || COALESCE(g.sample, '(empty)')
        )
      END AS j
    FROM grp g CROSS JOIN atlas a CROSS JOIN denom d
  ) s;
$function$;
