-- Extends the base-edition fix (same migration hour) to the PARALLEL rows, on the same evidence
-- standard and for the same reason: one meaning for one column.
--
-- MEASURED across the 3,795 Top Shot parallel editions carrying an Atlas number:
--   • **3,346 already equal Atlas's minted count** — so "mint size, as the marketplace displays it"
--     is already the intended meaning for a `::N` row; this is not a redefinition.
--   • 4 equal the post-burn effective supply instead.
--   • **392 are neither**, and they fail in two distinct, visible ways:
--       `124:4743::1`  stored **7,158** · actual mint **500**  ← the BASE edition's count leaked onto
--                       an Explosion parallel, making a /500 look like a /7,158
--       `273:9056::19` stored 19 · actual 25   ┐ recent sets, undercounted — the shape you get from
--       `273:9052::18` stored 48 · actual 50   │ counting OBSERVED HOLDERS instead of the mint size
--       `273:9055::20` stored 8  · actual 10   ┘
-- A parallel is the scarcest thing a collector owns; a 14x overstatement of its supply is the worst
-- kind of number to be wrong about, and an understatement is a fake-scarcity claim.
--
-- RULE, now uniform: `editions.circulation_count` is **this printing's own mint**.
--   • BASE rows keep the `atlas <= incoming` guard — a single printing's mint can never exceed the
--     chain's all-printings total, so a larger Atlas number is a bad read and is ignored.
--   • PARALLEL rows take Atlas unconditionally when present and > 0. There is no containment
--     relationship to check (the base no longer holds the total), and Atlas is the only per-printing
--     authority we have: 88 % of the population already agrees with it, and every disagreement
--     inspected is ours.
-- The post-burn number is not lost — `badge_editions.effective_supply` carries it per printing, for
-- any surface that wants burn-adjusted scarcity rather than mint size.
-- anon-exec: intentional — trg_topshot_normalize_base_club_circulation is a SNAPSHOT replace (see
--   the sibling migration 20260904145331): CREATE OR REPLACE does not reset a function ACL, so a
--   REVOKE here would change production rather than describe it. Verified in prod after applying:
--   has_function_privilege('anon', …) = false. RETURNS trigger, SECURITY INVOKER.
--   `sync_topshot_base_circulation_from_atlas` keeps its existing REVOKE … FROM PUBLIC, anon,
--   authenticated / postgres+service_role+cron_heavy grant.
-- REVERT: audit_20260904_base_circulation_sync holds every old value (base and parallel);
--   UPDATE editions e SET circulation_count = a.old_circulation FROM that table WHERE a.edition_id = e.id.

CREATE OR REPLACE FUNCTION public.trg_topshot_normalize_base_club_circulation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_atlas integer;
  v_is_base boolean;
BEGIN
  -- Existing behaviour first: the hardcoded series-8 families (base rows only, by its own guard).
  NEW.circulation_count := public.topshot_normalize_circulation(
    NEW.collection_id, NEW.series, NEW.external_id, NEW.set_name, NEW.circulation_count);

  IF NEW.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     AND NEW.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  THEN
    v_is_base := NEW.external_id ~ '^[0-9]+:[0-9]+$';

    SELECT be.circulation_count INTO v_atlas
      FROM public.badge_editions be
     WHERE be.collection_id = NEW.collection_id
       AND be.external_id   = NEW.external_id
       AND be.circulation_count IS NOT NULL
       AND be.circulation_count > 0;

    IF v_atlas IS NOT NULL THEN
      IF v_is_base THEN
        -- A printing's mint cannot exceed the all-printings total; a larger number is a bad read.
        IF NEW.circulation_count IS NOT NULL AND v_atlas <= NEW.circulation_count THEN
          NEW.circulation_count := v_atlas;
        END IF;
      ELSE
        -- Parallel: Atlas is the only per-printing authority, in both directions.
        NEW.circulation_count := v_atlas;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

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
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       AND be.circulation_count IS NOT NULL
       AND be.circulation_count > 0
       AND be.circulation_count IS DISTINCT FROM e.circulation_count
       AND (
         -- base: only downward (the parallels being removed); parallel: either direction
         e.external_id !~ '^[0-9]+:[0-9]+$'
         OR (e.circulation_count IS NOT NULL AND be.circulation_count < e.circulation_count)
       )
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
