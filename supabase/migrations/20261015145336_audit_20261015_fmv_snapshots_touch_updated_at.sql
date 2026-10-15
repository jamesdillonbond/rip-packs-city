-- R126 (deep audit run 6, 2026-10-15): four functions UPDATE fmv_snapshots.fmv_usd in place
-- without bumping updated_at (fmv_apply_thin_sale_haircut, fmv_apply_thin_sale_haircut_for_editions,
-- fmv_clamp_disconnected_ask, fmv_clamp_disconnected_ask_for_editions), so the incremental
-- refresh_edition_fmv_current pass never sees the correction (check_edition_fmv_current_source_drift
-- returned 8 rows at 2026-10-15 1:06 AM PT, cache = source/0.55). This trigger stamps updated_at on
-- any change to fmv_usd or confidence, for every writer.
-- anon-exec: intentional — trigger function, REVOKEd from PUBLIC/anon/authenticated (fmv_snapshots_touch_updated_at)
-- REVERT:
--   DROP TRIGGER IF EXISTS fmv_snapshots_touch_updated_at_trg ON public.fmv_snapshots;
--   DROP FUNCTION IF EXISTS public.fmv_snapshots_touch_updated_at();
CREATE OR REPLACE FUNCTION public.fmv_snapshots_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.fmv_usd IS DISTINCT FROM OLD.fmv_usd OR NEW.confidence IS DISTINCT FROM OLD.confidence THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fmv_snapshots_touch_updated_at() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER fmv_snapshots_touch_updated_at_trg
  BEFORE UPDATE OF fmv_usd, confidence ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_touch_updated_at();
