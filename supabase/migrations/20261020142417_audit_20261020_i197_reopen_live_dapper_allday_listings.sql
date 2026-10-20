-- 2026-10-20 (PT) — known-issues #197, the pending write (UPDATE-only, no deletes). Cowork cloud, ~7:35 AM PT.
--
-- 20260925230134 closed every open All Day source='direct' row as 'unpurchasable' on the premise that 'direct' = the
-- Flowty fork. Since ~05-18 the retry paths had written Dapper V1 NFTStorefront and Dapper V2 NFTStorefrontV2 listings
-- as 'direct' (fixed 10-19, lib/allday/listing-source.ts). 21,060 rows listed on/after 2026-05-15 were closed that way:
--   * 2,927 duplicate another source's row (2,712 storefront_v2 + 215 correctly sourced twins)  -> 'duplicate'
--   * 18,133 have no other copy; each was read on chain 10-19 6:57-6:58 PM PT (audit_20261019_i197_results):
--       V1 live 2,848 · gone 1,423 · purchased 1,838 · ghost 32;  V2 live 14 · gone 11,975 · ghost 3.
-- The 2,862 LIVE rows were RE-READ on chain 10-20 ~7:22-7:30 AM PT (audit_20261020_i197_reread, 192/192 scripts 200,
-- same two Cadence scripts, sealed block): 2,862 still live, 0 changed. Only rows that re-read live are reopened.
--
-- Effect: 2,862 buyable Dapper listings return to All Day floors under direct_v1 / direct_v2 with verified_at = the
-- re-read time; the other 15,271 keep completed_at and take their true source + status (purchased / vanished /
-- ghosted). Rows listed before 2026-05-15 are the real fork and are untouched. allday_listings_sold_after_listing has
-- 0 rows for any of these ids (checked), so no ghost-table relabel is needed.
--
-- Revert (restores every touched column from the backup):
--   UPDATE cached_listings_v2 v SET source='direct', completed_at=b.completed_at, completed_status=b.completed_status,
--     verified_at=b.verified_at
--   FROM audit_20261020_i197_apply_backup b
--   WHERE v.listing_resource_id=b.listing_resource_id AND v.source=b.new_source;

CREATE TABLE public.audit_20261020_i197_apply_backup AS
WITH live AS (
  SELECT (e->'key'->>'value')::bigint AS lid, r.read_at
  FROM public.audit_20261020_i197_reread r, jsonb_array_elements(r.result->'value') e
  WHERE r.http_status = 200 AND (e->'value'->>'value') = 'live'
), first_read AS (
  SELECT k::bigint AS lid, status FROM public.audit_20261019_i197_results WHERE k ~ '^[0-9]+$'
)
SELECT v.listing_resource_id,
       v.source AS old_source,
       v.completed_at, v.completed_status, v.verified_at,
       CASE
         WHEN EXISTS (SELECT 1 FROM public.cached_listings_v2 x
                      WHERE x.listing_resource_id = v.listing_resource_id AND x.source <> 'direct') THEN 'duplicate'
         WHEN l.lid IS NOT NULL THEN 'reopen'
         WHEN f.status = 'purchased' THEN 'purchased'
         WHEN f.status = 'gone' THEN 'vanished'
         WHEN f.status = 'ghost' THEN 'ghosted'
         ELSE 'skip'
       END AS action,
       CASE
         WHEN EXISTS (SELECT 1 FROM public.cached_listings_v2 x
                      WHERE x.listing_resource_id = v.listing_resource_id AND x.source <> 'direct') THEN 'direct'
         WHEN v.custom_id IS NULL THEN 'direct_v1' ELSE 'direct_v2'
       END AS new_source,
       l.read_at AS live_read_at
FROM public.cached_listings_v2 v
LEFT JOIN live l ON l.lid = v.listing_resource_id
LEFT JOIN first_read f ON f.lid = v.listing_resource_id
WHERE v.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND v.source = 'direct'
  AND v.completed_status = 'unpurchasable'
  AND v.listed_at >= '2026-05-15';
ALTER TABLE public.audit_20261020_i197_apply_backup ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE n_total int; n_dup int; n_reopen int; n_skip int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE action='duplicate'), count(*) FILTER (WHERE action='reopen'),
         count(*) FILTER (WHERE action='skip')
    INTO n_total, n_dup, n_reopen, n_skip FROM public.audit_20261020_i197_apply_backup;
  IF n_total <> 21060 OR n_dup <> 2927 OR n_reopen <> 2862 OR n_skip <> 0 THEN
    RAISE EXCEPTION 'i197 plan drifted: total % dup % reopen % skip %', n_total, n_dup, n_reopen, n_skip;
  END IF;
END $$;

-- 1. duplicates: same source, honest status (completed_at kept).
UPDATE public.cached_listings_v2 v
SET completed_status = 'duplicate'
FROM public.audit_20261020_i197_apply_backup b
WHERE b.action = 'duplicate'
  AND v.listing_resource_id = b.listing_resource_id AND v.source = 'direct';

-- 2. closed for a real reason: true source + true status (completed_at kept).
UPDATE public.cached_listings_v2 v
SET source = b.new_source, completed_status = b.action
FROM public.audit_20261020_i197_apply_backup b
WHERE b.action IN ('purchased', 'vanished', 'ghosted')
  AND v.listing_resource_id = b.listing_resource_id AND v.source = 'direct';

-- 3. live on chain twice (10-19 evening, 10-20 morning): reopen under the true source.
UPDATE public.cached_listings_v2 v
SET source = b.new_source, completed_at = NULL, completed_status = NULL, verified_at = b.live_read_at
FROM public.audit_20261020_i197_apply_backup b
WHERE b.action = 'reopen'
  AND v.listing_resource_id = b.listing_resource_id AND v.source = 'direct';
