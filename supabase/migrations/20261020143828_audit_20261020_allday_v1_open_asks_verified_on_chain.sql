-- 2026-10-20 (PT) — NFL All Day: the 10,513 open source='direct_v1' listings had NEVER been verified on chain
-- (verified_at NULL on every one; direct_v2 and storefront_v2 are re-verified by the reconciler, V1 is not).
-- Read 10-20 ~7:40-7:55 AM PT through pg_net -> rest-mainnet /v1/scripts (sealed), the V1 script from
-- audit_20261019_i197_scripts (the #197 check), 817/817 scripts HTTP 200 (scratch audit_20261020_v1_open_verify):
--   live 10,049 · ghost 453 (NFT no longer in the seller's collection) · gone 7 · purchased 4.
-- 464 dead asks were being published; 287 of them were their edition's lowest open ask (403 editions touched).
-- This migration: closes the 464 with their true status (ghosted / vanished / purchased) and stamps verified_at on
-- the 10,049 live rows with the read time. UPDATE-only. Backup: audit_20261020_v1_verify_backup.
-- Revert:
--   UPDATE cached_listings_v2 v SET completed_at=b.completed_at, completed_status=b.completed_status,
--     verified_at=b.verified_at
--   FROM audit_20261020_v1_verify_backup b
--   WHERE v.listing_resource_id=b.listing_resource_id AND v.source='direct_v1';

CREATE TABLE public.audit_20261020_v1_verify_backup AS
WITH kv AS (
  SELECT (e->'key'->>'value')::bigint AS lid, (e->'value'->>'value') AS st, r.read_at
  FROM public.audit_20261020_v1_open_verify r, jsonb_array_elements(r.result->'value') e
  WHERE r.http_status = 200
)
SELECT v.listing_resource_id, v.completed_at, v.completed_status, v.verified_at, kv.st, kv.read_at
FROM kv
JOIN public.cached_listings_v2 v ON v.listing_resource_id = kv.lid AND v.source = 'direct_v1'
WHERE v.completed_at IS NULL;
ALTER TABLE public.audit_20261020_v1_verify_backup ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE n int; n_live int; n_dead int; n_other int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE st = 'live'),
         count(*) FILTER (WHERE st IN ('ghost','gone','purchased')),
         count(*) FILTER (WHERE st NOT IN ('live','ghost','gone','purchased'))
    INTO n, n_live, n_dead, n_other FROM public.audit_20261020_v1_verify_backup;
  IF n_other <> 0 OR n_dead > 600 OR n < 10000 THEN
    RAISE EXCEPTION 'v1 verify plan drifted: total % live % dead % other %', n, n_live, n_dead, n_other;
  END IF;
END $$;

UPDATE public.cached_listings_v2 v
SET completed_at = b.read_at,
    completed_status = CASE b.st WHEN 'ghost' THEN 'ghosted' WHEN 'gone' THEN 'vanished' ELSE 'purchased' END,
    verified_at = b.read_at
FROM public.audit_20261020_v1_verify_backup b
WHERE b.st IN ('ghost','gone','purchased')
  AND v.listing_resource_id = b.listing_resource_id AND v.source = 'direct_v1' AND v.completed_at IS NULL;

UPDATE public.cached_listings_v2 v
SET verified_at = b.read_at
FROM public.audit_20261020_v1_verify_backup b
WHERE b.st = 'live'
  AND v.listing_resource_id = b.listing_resource_id AND v.source = 'direct_v1' AND v.completed_at IS NULL;
