-- Top Shot BASE-edition circulation from the chain, replacing the dead GraphQL catalog walker's
-- one field that still matters daily.
--
-- WHY. `topshot-catalog-backfill` (Vercel cron, daily) has failed every tick since ~08-28 on
-- `public-api.nbatopshot.com` (CF 530 / 1033 — the host is decommissioned). Its circulation_count
-- refresh is what the scarcity / serial-premium / impossible-parallel surfaces key on. The count
-- is ON CHAIN: `TopShot.getNumMomentsInEdition(setID, playID)`. Measured 2026-09-04 on a hashed
-- sample of on-chain-keyed rows: every BASE row (external_id '<set>:<play>') agreed with the chain
-- exactly, after the series-8 normaliser below; every mismatch was a PARALLEL row
-- ('<set>:<play>::<sub>'), whose per-parallel count lives on the SubeditionAdmin resource and is
-- owned by `backfill-topshot-subedition-circulation`. So this touches base rows ONLY.
--
-- ONE NORMALISER, TWO CALLERS. `trg_topshot_normalize_base_club_circulation` rewrites series-8
-- Base/WNBA Base counts (strip the 99 Club Collection) and the /1000 debut/playoff sets (floor to
-- the thousand). A caller that compared a raw on-chain value against the stored (normalised) one
-- would see every series-8 Base Set row as "changed" every day and rewrite it to the same value —
-- 1,000+ no-op updates bumping `editions.updated_at` daily. The rule is therefore lifted into
-- `topshot_normalize_circulation()`, the trigger delegates to it (byte-identical semantics,
-- including the plpgsql IF quirk that a NULL `series` falls THROUGH to normalisation), and the
-- apply RPC compares against the normalised candidate so only real changes write.
--
-- The trigger's previous body was created outside the repo (no migration carries it); this
-- migration is now its record.

CREATE OR REPLACE FUNCTION public.topshot_normalize_circulation(
  p_collection_id uuid,
  p_series integer,
  p_external_id text,
  p_set_name text,
  p_n integer
) RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_n IS NULL THEN NULL
    -- Same truth table as the trigger's IF: a NULL series or set_name makes the guard NULL,
    -- which is "not true", so the row falls through to the families below.
    WHEN p_collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      OR p_series <> 8
      OR p_external_id !~ '^[0-9]+:[0-9]+$' THEN p_n
    -- Family A: Base Set / WNBA Base Set -> strip the Club Collection 99 only.
    WHEN p_set_name IN ('Base Set','WNBA Base Set') AND p_n % 100 = 99 THEN p_n - 99
    -- Family B: /1000-standard debut/playoff sets -> floor to nearest 1000.
    WHEN p_set_name IN ('Rookie Debut','WNBA Rookie Debut','2026 NBA Playoffs','Vintage Vibes',
                        'Bag Work','Clamps','Extra Spice','Hustle and Show','Hoop Vision')
      AND p_n >= 1000 AND p_n % 1000 <> 0 THEN p_n - (p_n % 1000)
    ELSE p_n
  END
$$;

-- anon-exec: intentional — RETURNS trigger, fired by the editions write trigger and not callable as an RPC; the default anon grant is closed anyway by the follow-up migration audit_20260904_topshot_normalize_trigger_fn_anon_exec_revoked (trg_topshot_normalize_base_club_circulation)
CREATE OR REPLACE FUNCTION public.trg_topshot_normalize_base_club_circulation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.circulation_count := public.topshot_normalize_circulation(
    NEW.collection_id, NEW.series, NEW.external_id, NEW.set_name, NEW.circulation_count);
  RETURN NEW;
END;
$$;

-- p_rows: [{"id": "<editions.id uuid>", "n": <on-chain numMinted>}, ...]
-- Updates ONLY Top Shot BASE rows whose stored count differs from the NORMALISED candidate, so a
-- daily full sweep writes exactly the rows the chain moved. Parallel rows sent by mistake are
-- ignored by the predicate, never written.
CREATE OR REPLACE FUNCTION public.apply_topshot_onchain_circulation(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $$
DECLARE
  v_rows int;
  v_changed int;
BEGIN
  SELECT count(*) INTO v_rows FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb));

  WITH v AS (
    SELECT (x->>'id')::uuid AS id, (x->>'n')::int AS n
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
    WHERE x->>'id' IS NOT NULL AND x->>'n' IS NOT NULL
  )
  UPDATE public.editions e
  SET circulation_count = v.n
  FROM v
  WHERE e.id = v.id
    AND e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND e.external_id ~ '^[0-9]+:[0-9]+$'
    AND e.circulation_count IS DISTINCT FROM
        public.topshot_normalize_circulation(e.collection_id, e.series, e.external_id, e.set_name, v.n);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  RETURN jsonb_build_object('rows', v_rows, 'changed', v_changed);
END;
$$;

REVOKE ALL ON FUNCTION public.topshot_normalize_circulation(uuid, integer, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_topshot_onchain_circulation(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_topshot_onchain_circulation(jsonb) TO service_role;

-- The Vercel cron route that drives this (app/api/cron/topshot-circulation-onchain, daily) writes
-- its own heartbeat + terminal row; watched from the start. Daily cadence: 3x silent, 6x no-success.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES (
  'topshot-circulation-onchain',
  4320,
  8640,
  'medium',
  true,
  'Daily Vercel cron (app/api/cron/topshot-circulation-onchain): reads TopShot.getNumMomentsInEdition for every Top Shot BASE edition via Flow REST and applies changes through apply_topshot_onchain_circulation() (normalised compare, base rows only). Replaces the circulation half of the dead topshot-catalog-backfill (public-api.nbatopshot.com decommissioned). ok=false on any Flow REST or RPC failure. Added 2026-09-04.'
)
ON CONFLICT (pipeline) DO UPDATE SET
  max_silent_minutes = EXCLUDED.max_silent_minutes,
  max_minutes_without_success = EXCLUDED.max_minutes_without_success,
  severity = EXCLUDED.severity,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes;