-- ─────────────────────────────────────────────────────────────────────────────
-- Register #120: `editions.circulation_count` is stale-LOW on some Top Shot
-- editions, the error is ONE-SIDED, it clusters by SET with a constant offset,
-- and NOTHING in this estate compares the column to the chain.
--
-- ⛔ THIS DOES NOT FIX IT, DELIBERATELY. #120's own exit says so: circulation is
-- the denominator under FMV, scarcity, tier logic and the `/N` a collector reads,
-- and a 9,539-edition rewrite driven by an unaudited script is the class this
-- repo keeps paying for. **Measure the rate first.** This is the instrument.
--
-- ── WHAT IT DOES ─────────────────────────────────────────────────────────────
-- Two pg_cron jobs, 15 minutes apart in the quiet window, because pg_net is
-- ASYNC and a function cannot read its own response in the same transaction:
--   03:25Z  dispatch_topshot_circulation_sample(50)  -> pg_net POSTs + pending rows
--   03:40Z  collect_topshot_circulation_sample()     -> decode, record, clear
--
-- The Cadence is the **production-verified literal already in
-- `lib/editions-hydrate.ts`** (`TopShot.getNumMomentsInEdition(setID:playID:)`),
-- copied verbatim. ⚠ **No new Cadence is authored here** — no Cadence MCP was
-- available, and CLAUDE.md forbids writing Cadence blind. The same literal was
-- used for every measurement in #116 and #120 and returned HTTP 200 on 26 of 26.
--
-- ── THE HONESTY RULES THIS TABLE IS BUILT AROUND ─────────────────────────────
-- ⛔ `chain_circulation` is NULLABLE and `agrees` is NULL whenever it is null.
-- A read that did not happen must never read as agreement — that is the single
-- most productive defect class on this platform, and a circulation audit that
-- silently counts failures as matches would be a textbook instance.
-- ⛔ `status` is recorded for EVERY row: 'ok', 'http_<code>', 'undecodable', or
-- 'no_response' (dispatched, nothing came back before the sweep). A reader who
-- only looks at `agrees` still cannot conclude anything from a null.
-- ⚠ `pg_net` purges `net._http_response` after a few hours, so a pending row
-- older than 2 h is resolved as 'no_response' rather than left to rot.
--
-- ── WHY 50 A DAY ─────────────────────────────────────────────────────────────
-- 9,539 base editions carry a circulation. 50/day walks them in ~191 days — but
-- **coverage is not the deliverable, the RATE is**, and 50/day pins it inside a
-- week. ⚠ It is also deliberately small because pg_net answers a batch when its
-- SLOWEST member finishes, and an over-eager pg_net lane is what head-of-line
-- blocked this platform on 2026-09-04 (jobid 55). 15 s timeout, quiet window.
--
-- ⚠ NEVER-AUDITED EDITIONS ARE PREFERRED so coverage grows, but selection falls
-- back to the least-recently-audited — so the sampler does not stall once the
-- fleet is covered, and re-checks catch an edition that grows later.
--
-- REVERT (all five parts):
--   SELECT cron.unschedule('rpc-circulation-chain-dispatch');
--   SELECT cron.unschedule('rpc-circulation-chain-collect');
--   DROP FUNCTION public.collect_topshot_circulation_sample();
--   DROP FUNCTION public.dispatch_topshot_circulation_sample(int);
--   DROP TABLE public.topshot_circulation_chain_pending;
--   DROP TABLE public.topshot_circulation_chain_audit;
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.topshot_circulation_chain_audit (
  edition_external_id text        NOT NULL,
  checked_on          date        NOT NULL,
  db_circulation      integer     NOT NULL,
  chain_circulation   integer,              -- NULL = the chain was not read
  agrees              boolean,              -- NULL whenever chain_circulation is NULL
  status              text        NOT NULL, -- ok | http_<code> | undecodable | no_response
  checked_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (edition_external_id, checked_on)
);
ALTER TABLE public.topshot_circulation_chain_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_circulation_chain_audit FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.topshot_circulation_chain_audit IS
  'Register #120. One row per (edition, day) comparing editions.circulation_count with the chain '
  '(TopShot.getNumMomentsInEdition). chain_circulation and agrees are NULL when the read did not '
  'happen, and status says why — a read that did not happen must never read as agreement. '
  'RECORDS ONLY: nothing here writes editions.circulation_count.';

CREATE TABLE IF NOT EXISTS public.topshot_circulation_chain_pending (
  request_id          bigint      PRIMARY KEY,
  edition_external_id text        NOT NULL,
  db_circulation      integer     NOT NULL,
  dispatched_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_circulation_chain_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_circulation_chain_pending FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.topshot_circulation_chain_pending IS
  'In-flight pg_net requests for the #120 circulation sampler. Cleared by '
  'collect_topshot_circulation_sample(); a row older than 2 h is resolved as no_response, because '
  'net._http_response is purged after a few hours and a pending row that rots is a silent gap.';

-- ── dispatch ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dispatch_topshot_circulation_sample(p_n integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_script text;
  v_sent   int := 0;
BEGIN
  -- Verbatim from lib/editions-hydrate.ts. Do not edit without the Cadence MCP.
  v_script := replace(encode(convert_to($cad$import TopShot from 0x0b2a3299cc857e29

access(all) fun main(setID: UInt32, playID: UInt32): {String: String} {
    let result: {String: String} = TopShot.getPlayMetaData(playID: playID) ?? {}

    if let setName = TopShot.getSetName(setID: setID) {
        result["__SetName"] = setName
    }
    if let series = TopShot.getSetSeries(setID: setID) {
        result["__SetSeries"] = series.toString()
    }
    if let circulation = TopShot.getNumMomentsInEdition(setID: setID, playID: playID) {
        result["__Circulation"] = circulation.toString()
    }

    return result
}$cad$, 'UTF8'), 'base64'), E'\n', '');

  WITH candidates AS (
    SELECT e.external_id,
           split_part(e.external_id, ':', 1) AS set_id,
           split_part(e.external_id, ':', 2) AS play_id,
           e.circulation_count,
           (SELECT max(a.checked_on) FROM public.topshot_circulation_chain_audit a
             WHERE a.edition_external_id = e.external_id) AS last_checked
      FROM public.editions e
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.external_id ~ '^[0-9]+:[0-9]+$'
       AND e.circulation_count IS NOT NULL AND e.circulation_count > 0
       -- Never re-dispatch something already in flight.
       AND NOT EXISTS (SELECT 1 FROM public.topshot_circulation_chain_pending p
                        WHERE p.edition_external_id = e.external_id)
     -- NULLS FIRST: never-audited editions first, then least-recently — so
     -- coverage grows and the sampler never stalls once the fleet is covered.
     ORDER BY last_checked NULLS FIRST, random()
     LIMIT greatest(1, least(p_n, 200))
  ), sent AS (
    INSERT INTO public.topshot_circulation_chain_pending (request_id, edition_external_id, db_circulation)
    SELECT net.http_post(
             url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=final',
             body := jsonb_build_object(
               'script', v_script,
               'arguments', jsonb_build_array(
                 replace(encode(convert_to(jsonb_build_object('type','UInt32','value',c.set_id)::text,'UTF8'),'base64'), E'\n',''),
                 replace(encode(convert_to(jsonb_build_object('type','UInt32','value',c.play_id)::text,'UTF8'),'base64'), E'\n','')
               )
             ),
             headers := '{"Content-Type": "application/json"}'::jsonb,
             timeout_milliseconds := 15000
           ),
           c.external_id, c.circulation_count
      FROM candidates c
    RETURNING 1
  )
  SELECT count(*) INTO v_sent FROM sent;

  -- Report what was inspected, not only that it ran.
  RETURN jsonb_build_object('ok', true, 'dispatched', v_sent,
                            'pending_total', (SELECT count(*) FROM public.topshot_circulation_chain_pending));
END;
$function$;

-- anon-exec: NOT intentional for dispatch_topshot_circulation_sample — ops writer, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.dispatch_topshot_circulation_sample(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_topshot_circulation_sample(integer) TO postgres, service_role;

-- ── collect ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.collect_topshot_circulation_sample()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_rows int := 0;
BEGIN
  WITH resolved AS (
    SELECT p.request_id, p.edition_external_id, p.db_circulation, p.dispatched_at,
           r.status_code,
           CASE WHEN r.status_code = 200 THEN
             (SELECT (kv->'value'->>'value')
                FROM jsonb_array_elements(
                       (convert_from(decode(trim(both '"' from r.content), 'base64'), 'UTF8')::jsonb)->'value'
                     ) kv
               WHERE kv->'key'->>'value' = '__Circulation'
               LIMIT 1)
           END AS chain_txt
      FROM public.topshot_circulation_chain_pending p
      LEFT JOIN net._http_response r ON r.id = p.request_id
     -- Either a response has landed, or the request is old enough to call lost.
     WHERE r.id IS NOT NULL OR p.dispatched_at < now() - interval '2 hours'
  ), written AS (
    INSERT INTO public.topshot_circulation_chain_audit
      (edition_external_id, checked_on, db_circulation, chain_circulation, agrees, status, checked_at)
    SELECT x.edition_external_id, current_date, x.db_circulation,
           x.chain_txt::int,
           -- ⛔ NULL, never false: a read that did not happen is not a disagreement.
           CASE WHEN x.chain_txt IS NOT NULL THEN (x.chain_txt::int = x.db_circulation) END,
           CASE WHEN x.status_code IS NULL          THEN 'no_response'
                WHEN x.status_code <> 200           THEN 'http_' || x.status_code
                WHEN x.chain_txt IS NULL            THEN 'undecodable'
                ELSE 'ok' END,
           now()
      FROM resolved x
    ON CONFLICT (edition_external_id, checked_on) DO UPDATE SET
      chain_circulation = EXCLUDED.chain_circulation,
      agrees            = EXCLUDED.agrees,
      status            = EXCLUDED.status,
      checked_at        = EXCLUDED.checked_at
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM written;

  DELETE FROM public.topshot_circulation_chain_pending p
   WHERE EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = p.request_id)
      OR p.dispatched_at < now() - interval '2 hours';

  RETURN jsonb_build_object(
    'ok', true,
    'recorded', v_rows,
    'still_pending', (SELECT count(*) FROM public.topshot_circulation_chain_pending),
    -- The running picture, so a reader never has to reconstruct it from `agrees` alone.
    'lifetime', (SELECT jsonb_build_object(
                   'rows', count(*),
                   'read_ok', count(*) FILTER (WHERE status = 'ok'),
                   'agree', count(*) FILTER (WHERE agrees),
                   'db_low', count(*) FILTER (WHERE agrees = false AND chain_circulation > db_circulation),
                   'db_high', count(*) FILTER (WHERE agrees = false AND chain_circulation < db_circulation),
                   'not_read', count(*) FILTER (WHERE chain_circulation IS NULL))
                 FROM public.topshot_circulation_chain_audit)
  );
END;
$function$;

-- anon-exec: NOT intentional for collect_topshot_circulation_sample — ops writer, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.collect_topshot_circulation_sample() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_topshot_circulation_sample() TO postgres, service_role;

COMMENT ON FUNCTION public.collect_topshot_circulation_sample() IS
  'Resolves in-flight #120 circulation probes into topshot_circulation_chain_audit. A response that '
  'never landed is recorded as no_response with chain_circulation and agrees NULL — never as '
  'agreement. Returns the lifetime split (read_ok / agree / db_low / db_high / not_read) so a reader '
  'cannot mistake "not measured" for "matched".';

-- ── schedule: quiet window, 15 minutes apart because pg_net is async ─────────
SELECT cron.schedule('rpc-circulation-chain-dispatch', '25 3 * * *',
                     $$SELECT public.dispatch_topshot_circulation_sample(50);$$);
SELECT cron.schedule('rpc-circulation-chain-collect', '40 3 * * *',
                     $$SELECT public.collect_topshot_circulation_sample();$$);

-- ── verification, same transaction ───────────────────────────────────────────
DO $verify$
DECLARE
  v_pop int;
BEGIN
  SELECT count(*) INTO v_pop
    FROM public.editions e
   WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND e.external_id ~ '^[0-9]+:[0-9]+$'
     AND e.circulation_count IS NOT NULL AND e.circulation_count > 0;
  -- Assert the population the sampler draws from, not merely that it installed.
  IF v_pop < 5000 THEN
    RAISE EXCEPTION 'candidate population is % base editions, expected ~9,539 — the sampler is drawing from the wrong set', v_pop;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-circulation-chain-dispatch' AND active)
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-circulation-chain-collect' AND active) THEN
    RAISE EXCEPTION 'the sampler is not fully scheduled';
  END IF;
END
$verify$;
