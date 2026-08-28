-- public.get_topshot_pool_backfill_targets(): stop the `has rips` TIER from
-- consuming every tick when every member of it is unconvertible.
--
-- ⚠ ORDER BY ONLY, and this is the load-bearing safety property, inherited
-- verbatim from 20260827030000. The WHERE clause is BYTE-IDENTICAL, so THE
-- ELIGIBLE SET IS UNCHANGED — this changes which of the eligible rows are tried
-- first, never which rows are eligible. **Nothing downstream can see a
-- different population, and no computed pack-EV number can change.** This is
-- scheduling, not pricing.
--
-- WHY. 20260827030000 fixed a wedge one level down and left this one standing.
-- It replaced a `first_seen_at DESC` tie-break (inert across a ~350-row tied
-- cohort, so the head was decided by physical order) with a 5-minute rotation
-- hash, and deliberately PRESERVED `(has rips) DESC` as the first key — "the one
-- ordering term carrying real signal, since a ripped pack is one users can
-- actually see". That reasoning is sound and is kept below.
--
-- 🚨 But the rotation only shuffles WITHIN a tier, and the tier itself is a hard
-- head. Measured 2026-08-28:
--
--     eligible backlog ......................... 368
--       tier 1, has rips ....................... 8      <- all unconvertible
--       tier 2, no rips ........................ 360
--     targets drawn per tick (cron `limit=3`) .. 3
--
-- **8 > 3**, so every tick drew all three targets from the same 8 rows, each
-- returned no editions, none was ever converted, the tier never emptied, and the
-- 360 behind it were unreachable — permanently, not probabilistically.
--
-- The result over the 24 h after 20260827030000 landed: 271 ticks, 125 ok, and
-- then **131 consecutive ticks (11 h) converting ZERO** with the same message,
-- `0/3 dists converted; 3 returned no editions`. It converted 342 dists in its
-- first 11 h (710 -> 368 backlog) and then stopped dead. It does not self-heal.
--
-- ⭐ POSITIVE CONTROL for the diagnosis, run before writing this: the previous
-- ORDER BY was simulated across 12 consecutive rotation buckets — 12 of 12 drew
-- all three targets from the 8, and ZERO reached the 360. If the stall were a
-- drained queue the sampler would be drawing the 360 and finding them empty; it
-- never drew them at all.
--
-- THE CHANGE. The `has rips` tier now applies only in one bucket out of three:
--
--     ORDER BY (has rips AND (bucket % 3) = 0) DESC, <same rotation hash>
--
-- so a wedged tier is MATHEMATICALLY INCAPABLE of consuming every tick, while
-- ripped packs keep a dedicated slot every ~15 minutes. Simulated over 12
-- consecutive buckets before applying:
--
--     buckets drawing all 3 from the rips tier .. 4  (the preserved priority)
--     buckets drawing ZERO from it ............. 8  (guaranteed progress)
--     progress slots per hour .................. 24 (against 0 today)
--     distinct dists touched over 12 buckets ... 29 (near-zero repeats)
--
-- At ~24 attempts/hour the 360-row backlog drains in roughly 15 hours.
--
-- ⓘ WHY %3 AND NOT %2 OR %4. A clear majority of ticks must make progress or a
-- future wedged tier merely slows the queue instead of stopping it; and a ripped
-- pack must still be picked up promptly. One dedicated slot per 15 minutes
-- satisfies the second while leaving 67% of ticks for the first. The constant is
-- a judgement, not a measurement, and it is the only number here that is.
--
-- ⛔ WHAT THIS IS NOT. It is NOT failure memory, which remains the real fix and
-- is still unbuilt: `pack_distributions` has no attempt or error column, so
-- nothing distinguishes "tried, upstream empty" from "not yet tried", and the 8
-- will keep being re-drawn in their one-in-three slot forever. This change stops
-- them BLOCKING the queue; it does not stop them being retried. Building that
-- needs a column plus an edge-function change and is filed, not done here.
--
-- ⛔ AND IT DOES NOT DIAGNOSE THE 8. They carry a uuid and have rips, so they are
-- not malformed in any way a query here can see; the emptiness is upstream in the
-- Top Shot GQL walk. That is a separate question and does not change this fix.
--
-- ⓘ `hashtext(...)::bigint` before `abs()` is deliberate and unchanged: hashtext
-- can return -2147483648, and abs() of that overflows int4 and raises.
--
-- anon-exec: unchanged. `get_topshot_pool_backfill_targets` is SECURITY DEFINER
-- and already revoked (anon=false, authenticated=false); it is called only by the
-- backfill-topshot-pack-supply edge function via the service role. No REVOKE is
-- added: CREATE OR REPLACE FUNCTION does not reset a function's ACL, so one here
-- would imply a privilege change that did not happen.
--
-- REVERT: re-apply 20260827030000_audit_20260827_pool_backfill_targets_rotate_instead_of_wedging.sql
-- verbatim. No data migration, no schedule change, nothing to unwind.

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
  ORDER BY (EXISTS (SELECT 1 FROM public.pack_rips r WHERE r.collection_id=d.collection_id AND r.dist_id=d.dist_id)
            AND (floor(extract(epoch FROM now()) / 300)::bigint % 3) = 0) DESC,
           abs(hashtext(d.dist_id || floor(extract(epoch FROM now()) / 300)::bigint::text)::bigint)
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),400);
$function$;
