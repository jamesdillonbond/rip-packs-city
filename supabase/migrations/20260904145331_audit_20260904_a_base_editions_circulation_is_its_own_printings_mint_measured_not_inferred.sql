-- THE 284-vs-249 QUESTION, ANSWERED WITH A MEASUREMENT.
--
-- RPC showed Sabonis `227:7574` as **#104 / 284**; Top Shot shows **#104/249**. The 284 is the
-- chain's `getNumMomentsInEdition(set, play)`, which counts EVERY printing together (249 Standard +
-- 25 Hexwave + 10 Jukebox); Top Shot displays the Standard printing's own mint. The moment page's
-- parallel ladder therefore read "Standard / 284 · Hexwave / 25 · Jukebox / 9" — double-counting,
-- because the 284 already contains the other two.
--
-- ⭐ THE DECIDING EVIDENCE (2026-09-04, now that the Atlas refresh gives a per-printing mint for
-- every edition): across **9,473** Top Shot base editions carrying an Atlas number, 8,161 agree with
-- `editions.circulation_count` exactly, **1,312 differ, and every single one differs by EXACTLY the
-- sum of its parallels' mints. Unexplained rows: ZERO.** There is no ambiguity to split — the stored
-- value is the all-printings total and Atlas's is the printing's own mint.
--
-- ⭐ AND THE INTENT WAS ALREADY OURS. `topshot_normalize_circulation` (the IMMUTABLE helper this
-- trigger calls) already subtracts parallel mints from base counts — "Base Set … n % 100 = 99 ->
-- n - 99" is the Club Collection /99 being removed, and the /1000 family is the same idea. It was
-- built as a HEURISTIC, limited to series 8 and a hardcoded set list, because the public contract
-- exposes no per-parallel count. **This migration does not overturn that design; it completes it
-- with measured data** — and leaves the heuristic in place as the fallback for the ~33 % of editions
-- Atlas has not walked yet.
--
-- WHY HERE. `zzz_topshot_normalize_base_club_circulation` is a BEFORE trigger on `editions`, so
-- EVERY writer passes through it: the hourly on-chain circulation route, the catalog backfill, this
-- migration's own corrective sync. Correcting the value here means no writer and no corrector can
-- flap against another — which is the failure mode that made this not worth doing before. The
-- IMMUTABLE `topshot_normalize_circulation` is deliberately NOT touched (an IMMUTABLE function that
-- reads a table is a footgun); the lookup lives in the plpgsql trigger, where reads are legal.
--
-- GUARDS: Top Shot only; BASE rows only (`^[0-9]+:[0-9]+$` — parallels already carry their own
-- count); the Atlas number must be present, > 0, and **≤ the incoming count**, because a single
-- printing's mint can never exceed the all-printings total, so anything larger is a bad read and
-- falls back rather than being trusted.
-- anon-exec: intentional — trg_topshot_normalize_base_club_circulation is a SNAPSHOT replace of an
--   existing trigger function, and CREATE OR REPLACE does not reset a function ACL, so a REVOKE
--   here would CHANGE production rather than describe it. Verified in prod after applying:
--   proacl = {postgres=X/postgres,service_role=X/postgres}, has_function_privilege('anon', …) =
--   false. It is also RETURNS trigger (unreachable through PostgREST) and SECURITY INVOKER.
--   The corrective sync `sync_topshot_base_circulation_from_atlas` IS a new function and takes a
--   real REVOKE … FROM PUBLIC, anon, authenticated below — postgres/service_role/cron_heavy only.
-- REVERT: restore the two-line trigger body (it did nothing but call the normaliser), then
--   UPDATE editions e SET circulation_count = a.old_circulation
--   FROM audit_20260904_base_circulation_sync a WHERE a.edition_id = e.id;
--   SELECT cron.unschedule('rpc-topshot-base-circulation-sync');

CREATE OR REPLACE FUNCTION public.trg_topshot_normalize_base_club_circulation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_atlas integer;
BEGIN
  -- Existing behaviour first: the hardcoded series-8 families.
  NEW.circulation_count := public.topshot_normalize_circulation(
    NEW.collection_id, NEW.series, NEW.external_id, NEW.set_name, NEW.circulation_count);

  -- Then prefer the MEASURED per-printing mint when we have one for this base edition.
  IF NEW.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND NEW.external_id ~ '^[0-9]+:[0-9]+$'
     AND NEW.circulation_count IS NOT NULL
  THEN
    SELECT be.circulation_count INTO v_atlas
      FROM public.badge_editions be
     WHERE be.collection_id = NEW.collection_id
       AND be.external_id   = NEW.external_id
       AND be.circulation_count IS NOT NULL
       AND be.circulation_count > 0;

    -- A printing's mint cannot exceed the all-printings total; a larger number is a bad read.
    IF v_atlas IS NOT NULL AND v_atlas <= NEW.circulation_count THEN
      NEW.circulation_count := v_atlas;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Corrective sync for rows already stored. Bounded, audited, and idempotent (the trigger above
-- computes the same value, so re-running writes nothing).
CREATE TABLE IF NOT EXISTS public.audit_20260904_base_circulation_sync (
  edition_id       uuid PRIMARY KEY,
  external_id      text NOT NULL,
  old_circulation  integer,
  new_circulation  integer NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260904_base_circulation_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_base_circulation_sync FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_base_circulation_sync TO postgres, service_role, cron_heavy;

CREATE OR REPLACE FUNCTION public.sync_topshot_base_circulation_from_atlas(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_n integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('sync_topshot_base_circulation_from_atlas')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  WITH cand AS (
    SELECT e.id, e.external_id, e.circulation_count AS old_c, be.circulation_count AS new_c
      FROM public.editions e
      JOIN public.badge_editions be
        ON be.collection_id = e.collection_id AND be.external_id = e.external_id
     WHERE e.collection_id = v_ts
       AND e.external_id ~ '^[0-9]+:[0-9]+$'
       AND be.circulation_count IS NOT NULL
       AND be.circulation_count > 0
       AND e.circulation_count IS NOT NULL
       AND be.circulation_count < e.circulation_count   -- strictly smaller = the parallels removed
     LIMIT GREATEST(p_limit, 1)
  ),
  logged AS (
    INSERT INTO public.audit_20260904_base_circulation_sync (edition_id, external_id, old_circulation, new_circulation)
    SELECT id, external_id, old_c, new_c FROM cand
    ON CONFLICT (edition_id) DO NOTHING
  ),
  upd AS (
    UPDATE public.editions e
       SET circulation_count = c.new_c
      FROM cand c
     WHERE e.id = c.id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM upd;

  IF v_n > 0 THEN
    PERFORM public.log_pipeline_run('topshot-base-circulation-sync', v_started, v_n, v_n, 0, true, NULL,
              'nba_top_shot', NULL, NULL,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                 'corrected', v_n, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('corrected', v_n);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_topshot_base_circulation_from_atlas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_topshot_base_circulation_from_atlas(integer) TO postgres, service_role, cron_heavy;

-- :47 — three other jobs hold that minute, all of them sub-second; this is a no-op once drained.
SELECT cron.schedule('rpc-topshot-base-circulation-sync', '47 * * * *', $$SELECT public.sync_topshot_base_circulation_from_atlas(500)$$);
