-- audit_20260925_golazos_reconcile_first_run_repair
--
-- The first production run of golazos-storefront-reconcile (2026-09-25 2:48 PM PT)
-- matched none of the existing rows: PostgREST returns cached_listings_v2's bigint
-- ids as JSON numbers and the storefront script returns strings, so the planner's
-- Map lookup never hit (fixed in code the same hour, with a test on the real shape).
-- Result: all 3,338 live listings inserted as new `storefront_v2` rows (duplicating
-- the live `direct_v2` rows), and all 514 open Golazos `direct_v2` rows closed as
-- `vanished`. This restores the pre-run state; the corrected job re-adds the
-- listings that are genuinely missing and closes the ones that are genuinely gone.
--
-- Scope is exact: `storefront_v2` and completed_status `vanished` were both
-- introduced today (20260925213345) and only that run has written them.
--
-- REVERT: re-insert from audit_20260925_gz_reconcile_first_run_backup.

CREATE TABLE public.audit_20260925_gz_reconcile_first_run_backup AS
SELECT * FROM public.cached_listings_v2
WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
  AND (source = 'storefront_v2' OR completed_status = 'vanished');

ALTER TABLE public.audit_20260925_gz_reconcile_first_run_backup ENABLE ROW LEVEL SECURITY;

DELETE FROM public.cached_listings_v2
WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
  AND source = 'storefront_v2';

UPDATE public.cached_listings_v2
SET completed_at = NULL, completed_status = NULL
WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
  AND completed_status = 'vanished';

DO $post$
DECLARE n_sf int; n_open int;
BEGIN
  SELECT count(*) INTO n_sf FROM public.cached_listings_v2 WHERE source = 'storefront_v2';
  SELECT count(*) INTO n_open FROM public.cached_listings_v2
    WHERE collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75' AND source = 'direct_v2' AND completed_at IS NULL;
  IF n_sf <> 0 THEN RAISE EXCEPTION 'storefront_v2 rows remain: %', n_sf; END IF;
  IF n_open <> 514 THEN RAISE EXCEPTION 'expected 514 open direct_v2 Golazos rows, got %', n_open; END IF;
END $post$;
