-- audit_20260823_get_series_detail_reads_the_rollup
--
-- Second half of 20260823030000. Applied SEPARATELY and only after the rollup
-- was seeded and proved equivalent, so there was never a window in which the
-- series pages rendered em dashes for stats that exist.
--
-- ── EQUIVALENCE, MEASURED BEFORE THE SWAP ───────────────────────────────────
-- The old body was still deployed while the rollup was seeded, so both could be
-- read with the SAME instrument in one query. All six aggregates matched
-- EXACTLY on four series spanning every code path:
--
--   allday series-4     54 ed · circ 77,199    · 9 sets · 49 players · fmv 2,591.09 · floor 1,741.23
--   golazos series-1   575 ed · circ 1,919,761 · 23 sets · 360 players · fmv 58,739.51 · floor 36,961.19
--   ufc series-1       115 ed · circ 1,270,968 · 5 sets · 111 players · fmv 453.04 · floor 221.60
--   pinnacle 2025       35 ed · circ 39,553    · 19 sets · 33 players · fmv 43.64 · floor 57.65
--
-- ⚠ The Pinnacle row is the one worth keeping: its floor_total EXCEEDS its
-- fmv_total (57.65 > 43.64). That is a real quirk of the collapse helper, and
-- it is reproduced rather than "corrected" — an equivalence proof that quietly
-- fixes an oddity is not an equivalence proof.
--
-- Cost after: get_series_detail on Top Shot series-7 (4,895 editions, the
-- largest and previously untested) = 18 ms / 504 buffers. Before, the 3,600-
-- edition series-4 was 21,229 ms warm against an 8 s PostgREST-bound ceiling.
--
-- Completeness after: all 26 slugs resolve; 0 unresolved, 0 NULL edition_count,
-- 0 never-computed, 1 genuinely zero (ufc_strike series 0, which really is
-- empty and must keep rendering the empty state).
--
-- ⚠ SIGNATURE, ARGUMENT NAMES AND PAYLOAD KEYS ARE UNCHANGED, so the four
-- callers need no edit: the layout's 404 gate, generateMetadata, the page, and
-- /api/og/series. The gate keeps its exact meaning — a series present in
-- collection_series resolves, one that is not returns NULL.
--
-- ⚠ THE AGGREGATES ARE NULL, NOT 0, WHEN THE ROLLUP HAS NO ROW. The old body
-- returned COALESCE(v_edition_count, 0), harmless when the count was always
-- computed and NOT harmless now: a series added to collection_series before its
-- first refresh would publish a confident "0 editions" for a series that may
-- hold thousands. `stats_computed_at` is added so a caller can tell
-- "not measured yet" from "measured as zero"; the page's `isEmpty` test was
-- changed from `(x ?? 0) === 0` to `x === 0` in the same commit for exactly
-- this reason.
--
-- Revert: restore the pre-2026-08-23 body (git log -S get_series_detail).

CREATE OR REPLACE FUNCTION public.get_series_detail(p_collection_id uuid, p_series_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '8s'
AS $fn$
DECLARE
  v_series          RECORD;
  v_collection_slug text;
  v_roll            RECORD;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_roll
  FROM series_detail_rollup
  WHERE collection_id = p_collection_id AND series_number = v_series.series_number;

  RETURN jsonb_build_object(
    'collection_id',      p_collection_id,
    'collection_slug',    v_collection_slug,
    'series_slug',        p_series_slug,
    'series_number',      v_series.series_number,
    'display_label',      v_series.display_label,
    'season',             v_series.season,
    'edition_count',      v_roll.edition_count,
    'total_circulation',  v_roll.total_circulation,
    'fmv_total_usd',      v_roll.fmv_total_usd,
    'floor_total_usd',    v_roll.floor_total_usd,
    'set_count',          v_roll.set_count,
    'player_count',       v_roll.player_count,
    'stats_computed_at',  v_roll.computed_at
  );
END;
$fn$;

-- Privileges re-asserted rather than assumed. CREATE OR REPLACE preserves the
-- ACL, but a replace that silently lost EXECUTE is exactly how /api/ready broke
-- for eight days (deep-audit R44). Measured before this migration: anon false,
-- authenticated false, service_role true — reproduced here verbatim.
REVOKE ALL ON FUNCTION public.get_series_detail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_series_detail(uuid, text) TO service_role;
