-- audit_20261015_fmv_snapshots_touch_updated_at_and_drop_zz_probes
-- NOT APPLIED: the auto-mode classifier denied apply_migration ("Production Deploy") during the 2026-10-15 deep audit. Run from the SQL editor, then git mv into supabase/migrations/ with a timestamp prefix.
-- CAUSE (R126): fmv_apply_thin_sale_haircut() / fmv_apply_thin_sale_haircut_for_editions() UPDATE fmv_usd + algo_version in place without bumping updated_at,
--   so refresh_edition_fmv_current's incremental pass never sees the correction; check_edition_fmv_current_source_drift() returned 8 rows (4 TS, 4 AD) at 2026-10-15 1:06 AM PT, cache = source/0.55.
-- EVIDENCE: deep-audit-2026-10-15 sweep C. fmv_snapshots is partitioned (relkind p); existing triggers: 4x BEFORE INSERT + tg_fmv_snapshots_set_collection (INSERT OR UPDATE).
-- Also drops scratch zz_probe_20261014 / zz_probe2_20261014 (select 1, 0 callers, no anon/auth grants).
-- AFTER APPLYING: confirm trigger exists on a partition, run refresh_edition_fmv_current(true) once, expect check_edition_fmv_current_source_drift() = [].
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
DROP FUNCTION IF EXISTS public.zz_probe_20261014();
DROP FUNCTION IF EXISTS public.zz_probe2_20261014();
