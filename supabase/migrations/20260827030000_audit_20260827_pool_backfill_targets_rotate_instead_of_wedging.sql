-- public.get_topshot_pool_backfill_targets(): rotate the sample instead of
-- re-serving the same unconvertible head rows forever.
--
-- ⚠ ORDER BY ONLY. The WHERE clause is byte-identical, so THE ELIGIBLE SET IS
-- UNCHANGED — this changes which of the eligible rows are tried first, never
-- which rows are eligible. Nothing downstream can see a different population.
--
-- WHY. `topshot-pack-pool-backfill` ran 808 times in 72 h and converted
-- ONE distribution (46 pool rows) against a backlog of 710 eligible dists.
-- 138 of the 139 runs in a 12 h window failed with the same functional message,
-- `0/3 dists converted; 3 returned no editions`.
--
-- The mechanism is in this function. Targets are selected by "NOT EXISTS a row
-- in pack_drop_pool", and a dist whose Top Shot GQL walk SUCCEEDS but returns
-- zero editions writes no pool row — so it stays eligible and is selected again
-- on the next tick, forever. There is no failure memory anywhere:
-- `pack_distributions` has no attempt or error column, and the edge function
-- records the empty walk only in its own `pipeline_runs.extra`.
--
-- The old ORDER BY made that permanent rather than merely likely:
--     ORDER BY (has rips) DESC, d.first_seen_at DESC NULLS LAST
-- ~350 of the eligible rows share first_seen_at = 2026-06-29 04:13:05.21+00, so
-- the sort is a TIE across the whole cohort and the head is decided by physical
-- order. `pack_distributions` is not being rewritten, so physical order is
-- stable and the SAME three rows were served on every tick. The queue advanced
-- only on the rare tick where a head row happened to be convertible.
--
-- ⭐ THE STRONGEST ARGUMENT FOR THIS CHANGE IS DIAGNOSTIC, NOT THROUGHPUT.
-- In its current state the pipeline CANNOT distinguish "3 dists are
-- unconvertible" from "710 dists are unconvertible" — it only ever asks about
-- three of them, so its failure rate carries no information about the backlog.
-- (The 2026-08-26 daytime-monitor filing read it as the former and named "3
-- permanently-unresolvable dists"; that reading is an artifact of the wedge.)
-- Once the sample rotates, the observed conversion rate IS the answer, because
-- the population being sampled is the whole backlog. **This turns an
-- undiagnosable stall into a measurement**, and that holds whether or not it
-- also increases throughput.
--
-- Rotation salt: a 5-minute epoch bucket, matching the caller's ~5-minute
-- cadence, so consecutive ticks draw disjoint samples. Verified read-only over
-- six consecutive buckets before this was applied: 18 distinct dists, zero
-- repeats. At 3 dists/tick the 710-row backlog is sampled roughly daily instead
-- of never.
--
-- ⓘ `hashtext(...)::bigint` before `abs()` is deliberate: hashtext can return
-- -2147483648, and abs() of that overflows int4 and raises.
--
-- ⓘ What is given up: the `first_seen_at DESC` newest-first preference. It was
-- already inert for the ~350-row tied cohort that makes up most of the backlog,
-- so it was buying ordering only among the handful of rows outside the tie.
-- `(has rips) DESC` — the one ordering term carrying real signal, since a
-- ripped pack is one users can actually see — is PRESERVED as the first key.
--
-- anon-exec: unchanged — get_topshot_pool_backfill_targets was already revoked,
-- verified live AFTER this apply: has_function_privilege() reads anon=false,
-- authenticated=false (SECURITY DEFINER, called only by the
-- backfill-topshot-pack-supply edge function via the service role). No REVOKE
-- is added: CREATE OR REPLACE FUNCTION does not reset a function's ACL, so one
-- here would imply a privilege change that did not happen.
--
-- Callers (six-source check): the edge function
-- supabase/functions/backfill-topshot-pack-supply/index.ts ONLY, at two call
-- sites (the pool backfill and its no-write diagnostic probe), both passing
-- p_only_with_rips := false. No pg_proc, pg_views, cron.job or pg_trigger
-- reference. Not pinned, and it had no committed migration before this file —
-- so this also gives it a revert path it did not have.
--
-- Revert: restore the previous ORDER BY:
--   ORDER BY (EXISTS (SELECT 1 FROM public.pack_rips r
--                     WHERE r.collection_id=d.collection_id AND r.dist_id=d.dist_id)) DESC,
--            d.first_seen_at DESC NULLS LAST

CREATE OR REPLACE FUNCTION public.get_topshot_pool_backfill_targets(p_limit integer DEFAULT 100, p_only_with_rips boolean DEFAULT true)
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
  ORDER BY (EXISTS (SELECT 1 FROM public.pack_rips r WHERE r.collection_id=d.collection_id AND r.dist_id=d.dist_id)) DESC,
           abs(hashtext(d.dist_id || floor(extract(epoch FROM now()) / 300)::bigint::text)::bigint)
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1),400);
$function$;
