-- WHY: the concierge's get_fmv distribution path reads the latest FMV for up to
-- 500 editions with `fmv_current.in(edition_id, ids)`. `fmv_current` is a
-- DISTINCT ON (edition_id) view over fmv_snapshots, and PostgREST's IN filter
-- does NOT push down into it: Postgres materialises the WHOLE DISTINCT ON —
-- 1,385,975 rows scanned to 27,186 distinct — and only then semi-joins the 500
-- ids. This is the documented "a DISTINCT ON view joined by key is a full pass
-- per call" shape, on the concierge's most-used tool.
--
-- MEASURED 2026-09-02, same 500 Top Shot "Base Set" editions, same session:
--   fmv_current .in(500 ids) ....... 1,334,789 buffers (~10.4 GB)   16,736 ms
--   per-id LATERAL LIMIT 1 .........     5,359 buffers                470 ms
--   => 249x fewer buffers, 35x faster. Judge this on BUFFERS, not wall clock.
--
-- The 16.7 s read sits inside a 60 s lambda that also runs the Anthropic tool
-- loop, so broad FMV questions did not merely run slowly — a live probe on
-- 2026-09-02 ("what is a Base Set common worth?") came back with "the FMV
-- lookup timed out on that one". The route's own comment chose fmv_current
-- deliberately, to dodge the 1,000-row PostgREST clamp on raw fmv_snapshots.
-- That reason was correct; the cost of the cure was never measured.
--
-- SEMANTICS: byte-for-byte the same selection rule as the view —
-- DISTINCT ON (edition_id) ORDER BY computed_at DESC — expressed per id.
-- `computed_at <= now()` is LOAD-BEARING: it is what lets the planner use
-- fmv_snapshots_<year>_edition_id_computed_at_* as a bounded index condition
-- instead of scanning the partition. Verified 2026-09-02 that fmv_snapshots
-- holds ZERO future-dated rows, so the predicate excludes nothing the view
-- would have returned.
--
-- REVERT: DROP FUNCTION public.get_editions_latest_fmv(uuid[]);
--         and restore the .from("fmv_current").in(...) read in
--         lib/concierge/fmv-distribution.ts (see that file's comment).

CREATE OR REPLACE FUNCTION public.get_editions_latest_fmv(p_edition_ids uuid[])
RETURNS TABLE (
  edition_id  uuid,
  fmv_usd     numeric,
  confidence  text,
  computed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- plpgsql, not LANGUAGE sql: a sql-language function is planned param-blind
  -- and this plan's whole value is the per-id index probe, which a generic
  -- plan can flatten into the same full pass the function exists to avoid.
  RETURN QUERY
  SELECT e.id, s.fmv_usd, s.confidence, s.computed_at
  FROM unnest(COALESCE(p_edition_ids, ARRAY[]::uuid[])) AS e(id)
  CROSS JOIN LATERAL (
    SELECT fs.fmv_usd, fs.confidence, fs.computed_at
    FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id
      AND fs.computed_at <= now()
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) s;
END;
$function$;

-- Service-role only: the concierge route calls this with the service key.
REVOKE ALL ON FUNCTION public.get_editions_latest_fmv(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_editions_latest_fmv(uuid[]) TO service_role;

COMMENT ON FUNCTION public.get_editions_latest_fmv(uuid[]) IS
'Latest FMV per edition for a bounded id list. Same selection rule as the fmv_current view (DISTINCT ON (edition_id) ORDER BY computed_at DESC) but expressed as a per-id LATERAL LIMIT 1, because filtering the view by key materialises the entire DISTINCT ON first: measured 2026-09-02 at 1,334,789 buffers / 16.7 s for 500 ids versus 5,359 buffers / 470 ms here. computed_at <= now() is load-bearing for the index bound.';
