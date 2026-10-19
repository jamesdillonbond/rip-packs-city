-- DB invariant: public.pinnacle_catalog_floor_ask_history_capture — the trigger that
-- records every CHANGE of a Pinnacle render's live floor ask, so an ask-anchored price
-- can be backtested (#193, 2026-10-19).
--
-- Pins:
--   * an UPDATE that leaves floor_ask unchanged writes NO history row (the floor sweep
--     re-stamps every catalog row each run; history must stay change-only);
--   * a changed floor writes one row stamped with the sweep's floor_ask_updated_at;
--   * a floor going to NULL (no live ask) is recorded, not skipped;
--   * a re-write at the same stamp updates the row instead of failing the sweep;
--   * an INSERT with a floor records it; an INSERT without one records nothing.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261019152952_audit_20261019_pinnacle_floor_ask_history_capture.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, floor_ask numeric, floor_ask_updated_at timestamptz);
CREATE TABLE public.pinnacle_floor_ask_history (
  render_id text NOT NULL, floor_ask numeric, observed_at timestamptz NOT NULL,
  PRIMARY KEY (render_id, observed_at));

-- >>> BEGIN verbatim pinnacle_catalog_floor_ask_history_capture (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_catalog_floor_ask_history_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.pinnacle_floor_ask_history (render_id, floor_ask, observed_at)
  VALUES (NEW.render_id, NEW.floor_ask, COALESCE(NEW.floor_ask_updated_at, now()))
  ON CONFLICT (render_id, observed_at) DO UPDATE
    SET floor_ask = EXCLUDED.floor_ask;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim pinnacle_catalog_floor_ask_history_capture <<<

CREATE TRIGGER pinnacle_catalog_floor_ask_history_ins_trg
  AFTER INSERT ON public.pinnacle_catalog
  FOR EACH ROW WHEN (NEW.render_id IS NOT NULL AND NEW.floor_ask IS NOT NULL)
  EXECUTE FUNCTION public.pinnacle_catalog_floor_ask_history_capture();

CREATE TRIGGER pinnacle_catalog_floor_ask_history_upd_trg
  AFTER UPDATE OF floor_ask ON public.pinnacle_catalog
  FOR EACH ROW WHEN (NEW.render_id IS NOT NULL AND NEW.floor_ask IS DISTINCT FROM OLD.floor_ask)
  EXECUTE FUNCTION public.pinnacle_catalog_floor_ask_history_capture();

-- INSERT: a floor is recorded; no floor records nothing.
INSERT INTO public.pinnacle_catalog VALUES ('a', 10, '2026-10-19 13:45+00'), ('b', NULL, '2026-10-19 13:45+00');
SELECT _assert_eq((SELECT count(*) FROM public.pinnacle_floor_ask_history WHERE render_id = 'a')::text, '1', 'insert with a floor writes one row');
SELECT _assert_eq((SELECT count(*) FROM public.pinnacle_floor_ask_history WHERE render_id = 'b')::text, '0', 'insert without a floor writes nothing');

-- A sweep that re-stamps an unchanged floor writes nothing.
UPDATE public.pinnacle_catalog SET floor_ask = 10, floor_ask_updated_at = '2026-10-19 19:45+00' WHERE render_id = 'a';
SELECT _assert_eq((SELECT count(*) FROM public.pinnacle_floor_ask_history WHERE render_id = 'a')::text, '1', 'unchanged floor: no new row');

-- A changed floor writes one row at the sweep stamp.
UPDATE public.pinnacle_catalog SET floor_ask = 8, floor_ask_updated_at = '2026-10-20 01:45+00' WHERE render_id = 'a';
SELECT _assert_eq((SELECT floor_ask FROM public.pinnacle_floor_ask_history WHERE render_id = 'a' AND observed_at = '2026-10-20 01:45+00')::text, '8', 'changed floor: recorded at the sweep stamp');

-- The floor disappearing is a fact too.
UPDATE public.pinnacle_catalog SET floor_ask = NULL, floor_ask_updated_at = '2026-10-20 07:45+00' WHERE render_id = 'a';
SELECT _assert((SELECT floor_ask IS NULL FROM public.pinnacle_floor_ask_history WHERE render_id = 'a' AND observed_at = '2026-10-20 07:45+00'), 'floor -> NULL: recorded as no live ask');
SELECT _assert_eq((SELECT count(*) FROM public.pinnacle_floor_ask_history WHERE render_id = 'a')::text, '3', 'three changes, three rows');

-- Two changes at one stamp do not fail the writer; the later value wins.
UPDATE public.pinnacle_catalog SET floor_ask = 5, floor_ask_updated_at = '2026-10-20 13:45+00' WHERE render_id = 'b';
UPDATE public.pinnacle_catalog SET floor_ask = 6, floor_ask_updated_at = '2026-10-20 13:45+00' WHERE render_id = 'b';
SELECT _assert_eq((SELECT string_agg(floor_ask::text, ',') FROM public.pinnacle_floor_ask_history WHERE render_id = 'b')::text, '6', 'same-stamp rewrite: one row, latest value');

ROLLBACK;
