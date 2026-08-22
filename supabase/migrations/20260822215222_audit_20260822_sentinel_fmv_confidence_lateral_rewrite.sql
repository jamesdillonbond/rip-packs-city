-- Rewrite the sentinel's FMV-confidence tally off `fmv_current` and onto a lateral
-- latest-per-edition read. `fmv_current` is a DISTINCT ON view, so the editions
-- predicate cannot push through it: the incumbent materialises the latest row for
-- EVERY edition in the estate before the join narrows to ~13.2k.
--
-- MEASURED warm-vs-warm 2026-08-22 21:5xZ (quiet window, io_wait 3 of 4 sessions):
--   incumbent  1,170,580 buffers / 1,629.8 ms   (Unique over Merge Append, 1,221,595 rows walked)
--   candidate     83,299 buffers /   146.6 ms   (Nested Loop, 13,241 index seeks)
--   => 14.05x fewer buffers, 11.1x faster. The planner's cost estimate said 3.3x;
--      the measurement is 4x better than the estimate, which is why this shipped.
--
-- EQUIVALENCE PROVEN both directions on the full predicate (not a sample):
--   14 groups each, 0 rows only-in-incumbent, 0 only-in-candidate, 13,241 editions both.
-- TIE CHECK (DISTINCT ON and ORDER BY..LIMIT 1 both break ties arbitrarily):
--   17 canonical editions have 2 snapshots sharing their max computed_at, but ZERO
--   of those ties carry DIFFERENT confidence, so the two forms cannot disagree on
--   this tally. ⚠ The tie population is non-zero, so if this ever becomes a
--   materialised nightly tally (frozen once, read all day) add a deterministic
--   secondary ordering first — an arbitrary tie-break freezes into the number.
--
-- ⚠ NOT INCLUDED, deliberately: `AND s.computed_at <= now()` would prune the empty
-- 2027 partition, which the candidate plan shows costing 26,482 of its 83,299
-- buffers across 13,241 zero-row loops (a further ~1.45x). It is left out because
-- the EXCEPT equivalence above was proven for THIS exact form, and shipping an
-- untested variation alongside a verified one is how a proof stops being a proof.
--
-- This is a MEASUREMENT function: it reads FMV and produces a monitoring tally. It
-- computes no price and no user-facing value changes.
--
-- anon-exec: unchanged — already revoked in prod. Verified with has_function_privilege
-- (not acl text): anon false, authenticated false, service_role true. CREATE OR REPLACE
-- does not reset a function's ACL, so no REVOKE is added here.
--
-- REVERT: re-apply the prior body, which is the same statement with
--   FROM public.fmv_current fc JOIN public.editions e ON e.id = fc.edition_id
-- in place of the CTE + LATERAL.

CREATE OR REPLACE FUNCTION public.sentinel_fmv_confidence_canonical_ts_split()
 RETURNS TABLE(printing text, confidence text, count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ed AS MATERIALIZED (
    SELECT id, external_id
    FROM public.editions
    WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  )
  SELECT
    CASE WHEN ed.external_id LIKE '%::%' THEN 'parallel' ELSE 'base' END AS printing,
    fc.confidence::text,
    count(*)::bigint
  FROM ed
  JOIN LATERAL (
    SELECT s.confidence
    FROM public.fmv_snapshots s
    WHERE s.edition_id = ed.id
    ORDER BY s.computed_at DESC
    LIMIT 1
  ) fc ON true
  GROUP BY 1, 2;
$function$;
