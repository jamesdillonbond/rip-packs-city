-- ─────────────────────────────────────────────────────────────────────────────
-- `pg_net_http_429` alarm (2026-09-26 8:25 PM PT): "10 pg_net-dispatched call(s)
-- returned HTTP 429 … NOT attributable". Body: QuickNode -32007 "100/second
-- request limit reached". rest-mainnet.onflow.org is QuickNode-fronted and
-- shared by every Flow lane (apis-and-cadence.md).
--
-- ── ATTRIBUTION (measured, not inferred) ─────────────────────────────────────
-- * All 10 × 429 in the 6 h window sit in ONE minute, 03:25Z = the
--   `rpc-circulation-chain-dispatch` pg_cron (`25 3 * * *`), which fires
--   `dispatch_topshot_circulation_sample(50)` — 50 pg_net POSTs in one instant.
-- * `topshot_circulation_chain_audit` agrees exactly: status 'http_429' = 10,
--   'ok' = 40 on each of the last THREE runs (checked_on 09-25, 09-26, 09-27 UTC);
--   50/50 ok on 09-22..09-24. A deterministic 10-of-50 is a burst ceiling, not
--   an outage. (The ledger's 09-25 health line already named this lane.)
-- * Nothing is fabricated: a 429'd edition records agrees = NULL, never a
--   match. The cost is 20 % of the daily sample and a nightly false-ish alarm.
--
-- ── THE FIX: same 50/day, 10 per tick, five ticks a minute apart ─────────────
-- The dispatcher already skips editions with a pending row, so five calls of 10
-- pick 50 DISTINCT editions. The last tick (03:29Z) plus the 15 s pg_net timeout
-- lands well before the 03:40Z collect, which is unchanged. No function body is
-- touched — schedule only.
--
-- REVERT:
--   SELECT cron.schedule('rpc-circulation-chain-dispatch', '25 3 * * *',
--                        $$SELECT public.dispatch_topshot_circulation_sample(50);$$);
-- ─────────────────────────────────────────────────────────────────────────────

SELECT cron.schedule('rpc-circulation-chain-dispatch', '25-29 3 * * *',
                     $$SELECT public.dispatch_topshot_circulation_sample(10);$$);

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'rpc-circulation-chain-dispatch' AND active
                    AND schedule = '25-29 3 * * *'
                    AND command LIKE '%dispatch_topshot_circulation_sample(10)%') THEN
    RAISE EXCEPTION 'circulation dispatch was not re-scheduled to 10 x 5 ticks';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'rpc-circulation-chain-collect' AND active
                    AND schedule = '40 3 * * *') THEN
    RAISE EXCEPTION 'circulation collect is not at 03:40Z — the dispatch window must end before it';
  END IF;
END
$verify$;
