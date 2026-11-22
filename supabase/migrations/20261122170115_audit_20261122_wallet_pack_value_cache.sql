-- audit_20261122_wallet_pack_value_cache
--
-- Inbox 2026-11-22T0440Z (filed for this thread): wallet_held_pack_value hits its own 20 s
-- statement_timeout on the biggest pack wallets — 4 PostgREST 500s on 11-22, and
-- 0xf77bf547fccf6656 (15,662 rips, 5,076 buys) measured 19.4 s / 834k buffers at 8:45 AM PT.
-- The cost is the full pack-history classification, not the v33 cap. A missing total was
-- shown honestly ("couldn't load"), but whales never saw theirs. Trevor 2026-11-22: "Apply it".
--
-- Fix: a per-wallet cache filled in the BACKGROUND, where the 20 s request ceiling does not
-- apply (the outer cron statement governs), and read first by lib/packs/held-pack-total.ts:
--   * cache younger than 30 min → served as is;
--   * otherwise the live read (as before); a success refreshes the cache;
--   * a live read that FAILS falls back to a cache row up to 24 h old — never $0.
-- refresh_wallet_pack_value_cache(p_budget_seconds) walks every saved Flow wallet, stalest
-- first, skipping rows fresher than 50 min, one COMMIT per wallet; pg_cron hourly at :16
-- (the minute with the fewest jobs, 2026-11-22), a BARE CALL (a multi-statement cron line
-- cannot COMMIT — 20261122150559) with a budget under the 120 s role timeout.
--
-- anon-exec: n/a (no new function) — the only routine is a PROCEDURE, revoked from PUBLIC, anon, authenticated below.
-- Revert:
--   SELECT cron.unschedule('rpc-wallet-pack-value-cache');
--   DROP PROCEDURE public.refresh_wallet_pack_value_cache(integer);
--   DROP TABLE public.wallet_pack_value_cache;

CREATE TABLE IF NOT EXISTS public.wallet_pack_value_cache (
  wallet_addr text PRIMARY KEY,
  value       jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.wallet_pack_value_cache IS
  'wallet_held_pack_value() per wallet, computed in the background (no 20 s request ceiling) and on each successful live read. Read by lib/packs/held-pack-total.ts: < 30 min served, else live, live failure falls back to <= 24 h. Never a source of $0: a failed compute writes nothing.';
ALTER TABLE public.wallet_pack_value_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wallet_pack_value_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.wallet_pack_value_cache TO service_role;

-- No SET clause and no EXCEPTION block in the procedure body: both break COMMIT.
CREATE OR REPLACE PROCEDURE public.refresh_wallet_pack_value_cache(p_budget_seconds integer DEFAULT 90)
LANGUAGE plpgsql
AS $pr$
DECLARE
  v_started timestamptz := clock_timestamp();
  w text;
  v jsonb;
  v_done integer := 0;
  v_failed integer := 0;
  v_left integer := 0;
BEGIN
  FOR w IN
    SELECT s.addr
    FROM (SELECT DISTINCT lower(sw.wallet_addr) AS addr
          FROM public.saved_wallets sw
          WHERE sw.user_id IS NOT NULL AND sw.wallet_addr ~* '^0x[0-9a-f]{16}$') s
    LEFT JOIN public.wallet_pack_value_cache c ON c.wallet_addr = s.addr
    WHERE c.computed_at IS NULL OR c.computed_at < now() - interval '50 minutes'
    ORDER BY c.computed_at NULLS FIRST, s.addr
  LOOP
    IF clock_timestamp() - v_started > make_interval(secs => p_budget_seconds) THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;
    v := public.wallet_held_pack_value(w);
    IF v IS NULL OR v ? 'error' THEN
      v_failed := v_failed + 1;
    ELSE
      INSERT INTO public.wallet_pack_value_cache (wallet_addr, value, computed_at)
      VALUES (w, v, clock_timestamp())
      ON CONFLICT (wallet_addr) DO UPDATE SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at;
      v_done := v_done + 1;
    END IF;
    COMMIT;
  END LOOP;
  PERFORM public.log_pipeline_run('wallet-pack-value-cache', v_started, v_done + v_failed + v_left,
    v_done, v_failed, v_failed = 0, NULL, NULL, NULL, NULL,
    jsonb_build_object('filled', v_done, 'failed', v_failed, 'over_budget', v_left,
                       'seconds', round(extract(epoch FROM clock_timestamp() - v_started))));
  COMMIT;
END
$pr$;

REVOKE ALL ON PROCEDURE public.refresh_wallet_pack_value_cache(integer) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('rpc-wallet-pack-value-cache', '16 * * * *',
  $$CALL public.refresh_wallet_pack_value_cache(90);$$);
