-- audit_20261103_pinnacle_editions_studio_no_fabricated_default
--
-- pinnacle_editions.studio carried DEFAULT 'Unknown', so every insert that
-- omits studio (pinnacle-metadata-backfill's catalog_upsert never sends it)
-- stored an INVENTED value — the "defaulted DB column" fabrication shape
-- (CLAUDE.md, Honesty). Measured 2026-11-03 ~11:20 AM PT: 488 of 635 rows
-- 'Unknown', still being created (3 rows 11-02, 34 in October). No repo writer
-- sends the literal; pinnacle-ingest (which does, via upsert_pinnacle_edition)
-- has not run in 30 days. studio is nullable; the only reader that returns it,
-- get_moment_detail, passes it through as JSON, and no page renders it. The
-- sniper derives its own studio from pinnacle_catalog.set_name and already
-- drops "unknown" from its dropdown. trg_normalize_pinnacle_edition only TRIMs
-- (TRIM(NULL) = NULL).
--
-- Change: drop the default; NULL the placeholder rows (backup kept).
-- franchise keeps its DEFAULT 'Unknown' (NOT NULL column, 0 rows hold it today,
-- and every writer sends franchise explicitly).
--
-- Revert:
--   ALTER TABLE public.pinnacle_editions ALTER COLUMN studio SET DEFAULT 'Unknown';
--   UPDATE public.pinnacle_editions pe SET studio = b.studio
--     FROM public.audit_20261103_pinnacle_studio_unknown_backup b WHERE b.id = pe.id;

CREATE TABLE public.audit_20261103_pinnacle_studio_unknown_backup AS
  SELECT id, studio, updated_at FROM public.pinnacle_editions WHERE studio = 'Unknown';
ALTER TABLE public.audit_20261103_pinnacle_studio_unknown_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261103_pinnacle_studio_unknown_backup FROM anon, authenticated;

ALTER TABLE public.pinnacle_editions ALTER COLUMN studio DROP DEFAULT;

UPDATE public.pinnacle_editions SET studio = NULL WHERE studio = 'Unknown';
