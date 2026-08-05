
DROP FUNCTION IF EXISTS public.resolve_special_serials_from_ownership(text, integer);
DROP FUNCTION IF EXISTS public.upsert_topshot_ownership_batch(jsonb);
DROP FUNCTION IF EXISTS public.upsert_allday_ownership_batch(jsonb);
DROP TABLE IF EXISTS public.topshot_ownership_snapshots;
DROP TABLE IF EXISTS public.allday_ownership_snapshots;
DELETE FROM public.flow_backfill_progress
 WHERE id IN ('topshot-deposit-scan-forward','topshot-deposit-scan-backward',
              'allday-deposit-scan-forward','allday-deposit-scan-backward');
