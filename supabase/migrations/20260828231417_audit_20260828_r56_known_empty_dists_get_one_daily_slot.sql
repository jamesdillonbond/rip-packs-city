-- audit_20260828_r56_known_empty_dists_get_one_daily_slot
-- R56 (deep-audit run 4): the pool-backfill sampler re-draws PERMANENTLY-EMPTY
-- distributions ~12x/hour forever. The 17 dists recorded in
-- topshot_atlas_no_pool_dists ("bundle box/case dist: empty editions on both
-- dist_id and pack_listing_uuid forms") are structurally not poolable, and after
-- the fresh backlog drains the queue becomes ~100% of them again — the measured
-- 74% wasted-tick state of 2026-08-27/28.
--
-- ⚠ THIS CHANGES THE WHERE — a deliberate departure from 20260828025307's
-- "ORDER BY only, eligible set unchanged" safety property, stated rather than
-- smuggled: a dist listed in topshot_atlas_no_pool_dists is now eligible in
-- exactly ONE 5-minute bucket per day (hash-spread), instead of every tick.
-- Over any day the eligible POPULATION is unchanged; within a tick it excludes
-- only rows whose probe is known-futile. No computed pack-EV value can change —
-- conversions only ever ADD pool rows, and each known-empty still gets its
-- daily retry, so this remains scheduling, not pricing, and it SELF-HEALS: if
-- Atlas ever returns editions for one, its daily attempt converts it and the
-- pool-row NOT EXISTS removes it from the backlog permanently.
--
-- Simulated before applying (2026-08-28): backlog 98 = 17 known-empty + 81
-- fresh; each known-empty admits in exactly 1 of 288 daily buckets (range 1..1);
-- 0 pass the gate in the current bucket. Waste on the known set drops ~288x.
--
-- ⛔ NOT COVERED (the filed edge-function half, still owed): nothing WRITES
-- topshot_atlas_no_pool_dists any more (last_checked_at max 2026-07-17), so a
-- NEW permanently-empty dist keeps full-rate retries until the writer is revived
-- or a failure-memory column ships. This migration spends the knowledge we
-- already have; it does not grow it.
--
-- anon-exec unchanged (SECURITY DEFINER, anon/authenticated false; CREATE OR
-- REPLACE with the same signature does not reset the ACL).
--
-- REVERT: re-apply 20260828025307_audit_20260828_pool_backfill_rips_tier_cannot_consume_every_tick.sql verbatim.

CREATE OR REPLACE FUNCTION public.get_topshot_pool_backfill_targets(
  p_limit integer DEFAULT 100,
  p_only_with_rips boolean DEFAULT true
)
RETURNS TABLE(dist_id text, uuid text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT d.dist_id, d.metadata->>'uuid' AS uuid
  FROM public.pack_distributions d
  WHERE d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND d.metadata->>'uuid' IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.pack_drop_pool p
                    WHERE p.collection_id=d.collection_id AND p.dist_id=d.dist_id)
    AND (NOT p_only_with_rips OR EXISTS (SELECT 1 FROM public.pack_rips r
                    WHERE r.collection_id=d.collection_id AND r.dist_id=d.dist_id))
    -- R56: a dist recorded as permanently empty gets ONE hash-spread 5-minute
    -- bucket per day instead of every tick. See the migration header.
    AND (NOT EXISTS (SELECT 1 FROM public.topshot_atlas_no_pool_dists n
                     WHERE n.dist_id = d.dist_id)
         OR (floor(extract(epoch FROM now()) / 300)::bigint % 288)
            = abs(hashtext(d.dist_id)::bigint) % 288)
  ORDER BY (EXISTS (SELECT 1 FROM public.pack_rips r WHERE r.collection_id=d.collection_id AND r.dist_id=d.dist_id)
            AND (floor(extract(epoch FROM now()) / 300)::bigint % 3) = 0) DESC,
           abs(hashtext(d.dist_id || floor(extract(epoch FROM now()) / 300)::bigint::text)::bigint)
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),400);
$function$;
