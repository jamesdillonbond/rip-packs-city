-- audit_20261122_portfolio_snapshot_pack_low_ask
--
-- Trevor 2026-11-21: "We should show the pack low ask total, when showing the
-- aggregated wallet value" → "Do what makes sense" → "Apply it" (value history).
--
-- The daily portfolio snapshot keeps its moment total exactly as it was
-- (total_fmv is NOT changed — folding packs in would make every account's
-- history jump on the day this shipped). Sealed packs are recorded BESIDE it,
-- from today forward, so the history has a sealed-pack line once days accrue:
--   pack_low_ask_usd  — sum of the lowest live ask of each held sealed pack
--   pack_held_count   — sealed packs held
--   pack_listed_count — of which have a live ask (an unlisted drop adds $0)
-- NULL = not measured (before 2026-11-22, or the read failed) — never 0.
--
-- Same wallet set as total_fmv: every saved Flow wallet of the owner
-- (snapshot_all_user_portfolios groups saved_wallets by user_id).
-- Per wallet: wallet_held_pack_value() (v2, 0.2–3.1 s measured 2026-11-21).
--
-- Revert:
--   SELECT cron.unschedule('rpc-portfolio-snapshot-packs');
--   DROP PROCEDURE public.fill_portfolio_snapshot_pack_values(integer);
--   DROP FUNCTION public.portfolio_owner_pack_value(text);
--   ALTER TABLE public.portfolio_snapshots DROP COLUMN pack_low_ask_usd,
--     DROP COLUMN pack_held_count, DROP COLUMN pack_listed_count;

ALTER TABLE public.portfolio_snapshots
  ADD COLUMN IF NOT EXISTS pack_low_ask_usd  numeric,
  ADD COLUMN IF NOT EXISTS pack_held_count   integer,
  ADD COLUMN IF NOT EXISTS pack_listed_count integer;

COMMENT ON COLUMN public.portfolio_snapshots.pack_low_ask_usd IS
  'Sealed packs held across the owner''s saved Flow wallets, at the lowest live ask (sum). Beside total_fmv, never in it. NULL = not measured (pre-2026-11-22 or read failed). Filled by fill_portfolio_snapshot_pack_values().';

-- One owner's sealed-pack total. NULL on ANY failed wallet read: a partial sum
-- would publish a number lower than the truth as if measured.
CREATE OR REPLACE FUNCTION public.portfolio_owner_pack_value(p_owner_key text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  w text;
  j jsonb;
  v_low numeric := 0;
  v_held integer := 0;
  v_listed integer := 0;
  v_wallets integer := 0;
BEGIN
  FOR w IN
    SELECT DISTINCT lower(sw.wallet_addr)
    FROM saved_wallets sw
    WHERE sw.user_id::text = p_owner_key
      AND sw.wallet_addr ~* '^0x[0-9a-f]{16}$'
  LOOP
    BEGIN
      j := public.wallet_held_pack_value(w);
    EXCEPTION WHEN OTHERS THEN  -- when-others-timeout-blind: intentional — a timeout kill should end the run; any other error is this owner's failed read
      RETURN NULL;
    END;
    IF j IS NULL OR j ? 'error' THEN
      RETURN NULL;
    END IF;
    v_low    := v_low + COALESCE((j->>'floor_ask_usd')::numeric, 0);
    v_held   := v_held + COALESCE((j->>'count')::int, 0);
    v_listed := v_listed + COALESCE((j->>'listed_count')::int, 0);
    v_wallets := v_wallets + 1;
  END LOOP;
  RETURN jsonb_build_object('low_ask_usd', round(v_low, 2), 'held', v_held,
                            'listed', v_listed, 'wallets', v_wallets);
END
$fn$;

-- anon-exec: revoked (portfolio_owner_pack_value) — new function; reads any owner's wallets, service-only.
REVOKE ALL ON FUNCTION public.portfolio_owner_pack_value(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portfolio_owner_pack_value(text) TO postgres, service_role;

-- Fill today's snapshot rows that have no pack value yet. One owner per
-- transaction (COMMIT each), oldest row first, soft budget so a slow day
-- leaves the rest NULL for the retry run instead of losing what was done.
-- No SET clause and no EXCEPTION block: both break COMMIT in a procedure.
-- A failed owner read returns NULL from the helper and is left NULL.
CREATE OR REPLACE PROCEDURE public.fill_portfolio_snapshot_pack_values(p_budget_seconds integer DEFAULT 240)
LANGUAGE plpgsql
AS $pr$
DECLARE
  v_started timestamptz := clock_timestamp();
  r record;
  v jsonb;
  v_done integer := 0;
  v_failed integer := 0;
  v_left integer := 0;
BEGIN
  FOR r IN
    SELECT ps.id, ps.owner_key
    FROM public.portfolio_snapshots ps
    WHERE ps.snapshot_date = CURRENT_DATE
      AND ps.pack_low_ask_usd IS NULL
    ORDER BY ps.id
  LOOP
    IF clock_timestamp() - v_started > make_interval(secs => p_budget_seconds) THEN
      v_left := v_left + 1;
      CONTINUE;
    END IF;
    v := public.portfolio_owner_pack_value(r.owner_key);
    IF v IS NULL THEN
      v_failed := v_failed + 1;
    ELSE
      UPDATE public.portfolio_snapshots
         SET pack_low_ask_usd  = (v->>'low_ask_usd')::numeric,
             pack_held_count   = (v->>'held')::int,
             pack_listed_count = (v->>'listed')::int
       WHERE id = r.id;
      v_done := v_done + 1;
    END IF;
    COMMIT;
  END LOOP;
  PERFORM public.log_pipeline_run('portfolio-snapshot-packs', v_started, v_done + v_failed + v_left,
    v_done, v_failed, v_failed = 0 AND v_left = 0, NULL, NULL, NULL, NULL,
    jsonb_build_object('filled', v_done, 'failed', v_failed, 'over_budget', v_left,
                       'seconds', round(extract(epoch FROM clock_timestamp() - v_started))));
  COMMIT;
END
$pr$;

REVOKE ALL ON PROCEDURE public.fill_portfolio_snapshot_pack_values(integer) FROM PUBLIC, anon, authenticated;

-- 55 min after the primary snapshot (07:01 UTC = 11:01 PM PT) and ~40 min after the retry (11:17 UTC); minute 56 had no other job at those hours (2026-11-22).
-- The second pass fills rows the first left NULL (snapshot retry rows, failures).
SELECT cron.schedule('rpc-portfolio-snapshot-packs', '56 7,11 * * *',
  $$SET statement_timeout = '300s'; CALL public.fill_portfolio_snapshot_pack_values(240);$$);
